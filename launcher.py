#!/usr/bin/env python3
"""pif — fuzzy launcher for pi coding-agent sessions.

Single flow:
  1. Pick a working directory (built from pi's session history, most
     recently used first) — or pick "+" to type a fresh path.
  2. Pick a session in that directory to resume — or pick "+" to
     start a new session there.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from enum import Enum, auto
from pathlib import Path
from typing import Literal, TypeVar

from InquirerPy.prompts.filepath import FilePathPrompt
from InquirerPy.prompts.fuzzy import FuzzyPrompt

SESSIONS_DIR = Path.home() / ".pi" / "agent" / "sessions"
SCAN_LINES = 40  # session header + name + first user msg live near the top


class Pick(Enum):
    """Pseudo-entries in the fuzzy menus (enum members narrow cleanly with `is`)."""

    NEW_DIR = auto()  # "+ new session in a directory of your choice"
    NEW_SESSION = auto()  # "+ new session in the selected directory"


# --------------------------------------------------------------- scanning

def quick_cwd(path: Path) -> str | None:
    """cwd from the session header line — cheap, no full scan."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            e = json.loads(fh.readline())
        return e.get("cwd") if e.get("type") == "session" else None
    except (OSError, json.JSONDecodeError):
        return None


def collect_dirs() -> dict[str, list[tuple[float, Path]]]:
    """cwd -> [(mtime, session-file)] for every session with a cwd."""
    groups: dict[str, list[tuple[float, Path]]] = {}
    if SESSIONS_DIR.is_dir():
        for p in SESSIONS_DIR.rglob("*.jsonl"):
            cwd = quick_cwd(p)
            if cwd:
                groups.setdefault(cwd, []).append((p.stat().st_mtime, p))
    return groups


def parse_session(path: Path) -> dict[str, str | float]:
    """Extract a human label from the head of a session JSONL."""
    label = None
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= SCAN_LINES:
                    break
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = e.get("type")
                if t == "session_info" and e.get("name"):
                    label = e["name"]  # named session wins; stop scanning
                    break
                if t == "message" and e.get("message", {}).get("role") == "user":
                    c = e["message"].get("content")
                    if isinstance(c, str):
                        label = c
                    else:
                        for b in c or []:
                            if b.get("type") == "text":
                                label = b.get("text")
                                break
    except OSError:
        pass
    if label:
        label = " ".join(label.split())  # collapse whitespace/newlines
    return {
        "file": str(path),
        "label": label or "(no prompt yet)",
        "mtime": path.stat().st_mtime,
    }


# ------------------------------------------------------------------ menus

def fmt_dir(cwd: str, files: list[tuple[float, Path]]) -> str:
    latest = time.strftime("%Y-%m-%d %H:%M", time.localtime(max(m for m, _ in files)))
    n = len(files)
    word = "sessions" if n != 1 else "session"
    return f"{latest}  │  {n:>3} {word:<8}  │  {cwd}"  # word padded → `│` aligned


def fmt_session(s: dict) -> str:
    ts = time.strftime("%Y-%m-%d %H:%M", time.localtime(s["mtime"]))
    return f"{ts}  │  {s['label']}"


T = TypeVar("T")


def choose(prompt: str, choices: list[tuple[str, T]]) -> T | None:
    """Fuzzy-pick from (display, value) pairs. None on cancel."""
    return FuzzyPrompt(
        message=prompt,
        choices=[{"name": n, "value": v} for n, v in choices],
    ).execute()


def ask_directory() -> str | None:
    """Ask for a directory path (for starting a session somewhere new)."""
    raw = FilePathPrompt(
        message="directory for the new session ›",
        only_directories=True,
    ).execute()
    cwd = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(cwd):
        print(f"error: not a directory: {cwd}", file=sys.stderr)
        return None
    return cwd


# ----------------------------------------------------------------- launch

def run_pi(cwd: str, session: str | None = None) -> int:
    pi = shutil.which("pi")  # resolves pi.exe / pi.cmd from npm correctly
    if not pi:
        print("error: 'pi' not found on PATH", file=sys.stderr)
        return 1
    args = [pi] + (["--session", session] if session else [])
    try:
        return subprocess.run(args, cwd=cwd, check=False).returncode
    except KeyboardInterrupt:
        return 130


def main() -> int:
    groups = collect_dirs()
    dirs = sorted(groups, key=lambda c: max(m for m, _ in groups[c]), reverse=True)

    choices: list[tuple[str, str | Literal[Pick.NEW_DIR]]] = [
        ("+  new session in a directory of your choice…", Pick.NEW_DIR)
    ]
    choices += [(fmt_dir(c, groups[c]), c) for c in dirs]
    if not dirs:
        print(f"No sessions found under {SESSIONS_DIR} — starting fresh.")

    try:
        sel = choose("pi › working directory", choices)  # str | Pick | None
    except KeyboardInterrupt:
        return 0
    if sel is None:
        return 0
    if sel is Pick.NEW_DIR:
        try:
            cwd = ask_directory()
        except KeyboardInterrupt:
            return 0
        return run_pi(cwd) if cwd else 0

    # sel is a cwd (str) from history → list its sessions, newest first
    sessions = sorted(
        (parse_session(p) for _, p in groups[sel]),
        key=lambda s: s["mtime"],
        reverse=True,
    )
    schoices: list[tuple[str, dict | Literal[Pick.NEW_SESSION]]] = [
        ("+  new session here", Pick.NEW_SESSION)
    ]
    schoices += [(fmt_session(s), s) for s in sessions]
    try:
        sel2 = choose("pi › session", schoices)  # dict | Pick | None
    except KeyboardInterrupt:
        return 0
    if sel2 is None:
        return 0
    if isinstance(sel2, Pick):
        return run_pi(sel)
    return run_pi(sel, sel2["file"])


if __name__ == "__main__":
    raise SystemExit(main())
