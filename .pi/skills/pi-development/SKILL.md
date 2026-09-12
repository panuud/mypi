---
name: pi-development
description: How to work on Pi itself and its ecosystem — extensions, skills, prompt templates, themes, TUI components, SDK/RPC integration, custom providers, models, pi packages, environment variables, keybindings, sessions, compaction, and settings. Use when the user asks about Pi's features or asks to build, modify, debug, or explain Pi extensions, skills, themes, prompts, packages, providers, or models.
disable-model-invocation: true
---

# Pi Development

Pi is a minimal terminal coding harness, extended through TypeScript extensions,
skills, prompt templates, themes, and pi packages.

The harness normally injects a short list of Pi doc pointers into the system
prompt. That block is disabled here (via the `strip-pi-docs` extension) so it
does not consume attention on unrelated tasks. Load this skill whenever a task
is about Pi itself.

## Finding the docs

Prefer the environment variables (set by the `strip-pi-docs` extension); they
resolve to the exact installed package:

```bash
echo "$PI_DOCS_DIR"        # .../pi-coding-agent/docs
echo "$PI_EXAMPLES_DIR"    # .../pi-coding-agent/examples
echo "$PI_README_PATH"     # .../pi-coding-agent/README.md
```

If they are unset, locate the package root yourself:

```bash
pi_dir="$(npm root -g)/@earendil-works/pi-coding-agent"
# Nix/Guix/standalone binary installs may set PI_PACKAGE_DIR instead:
# pi_dir="$PI_PACKAGE_DIR"
ls "$pi_dir/docs"
```

Resolve references as:
- `docs/<name>.md` → `$PI_DOCS_DIR/<name>.md`
- `examples/...` → `$PI_EXAMPLES_DIR/...`
- the main README → `$PI_README_PATH`

Do **not** resolve `docs/...` or `examples/...` relative to the current working
directory; they live inside the Pi package.

## Topic map

| Topic | Doc | Examples |
|-------|-----|----------|
| Getting started | `quickstart.md` | — |
| Interactive use, slash commands, CLI | `usage.md` | — |
| Providers / auth | `providers.md`, `models.md` | — |
| Extensions (tools, commands, events, UI) | `extensions.md` | `examples/extensions/` |
| Skills | `skills.md` | — |
| Prompt templates | `prompt-templates.md` | — |
| Themes | `themes.md` | — |
| TUI components | `tui.md` | `examples/extensions/` |
| SDK / embedding | `sdk.md` | `examples/sdk/` |
| RPC mode | `rpc.md` | — |
| JSON event stream mode | `json.md` | — |
| Custom providers / OAuth | `custom-provider.md` | `examples/extensions/custom-provider-*` |
| Adding models | `models.md` | — |
| Pi packages (npm/git) | `packages.md` | — |
| Settings | `settings.md` | — |
| Sessions / branching | `sessions.md`, `session-format.md` | — |
| Compaction | `compaction.md` | `examples/extensions/custom-compaction.ts` |
| Keybindings | `keybindings.md` | — |
| Environment variables | `environment-variables.md` | — |
| Security / project trust | `security.md` | — |
| Containerization / sandboxing | `containerization.md` | `examples/extensions/sandbox`, `gondolin` |
| Platform setup | `windows.md`, `termux.md`, `tmux.md`, `terminal-setup.md` | — |
| Development / debugging | `development.md` | — |

The full index is `$PI_DOCS_DIR/index.md`.

## Rules

1. Read the relevant `.md` file **completely** before implementing, and follow
   its cross-references (for example, `tui.md` for the TUI API details).
2. Prefer the documented public API. Check the TypeScript definitions in the
   installed package (`dist/**/*.d.ts`) when a doc is ambiguous.
3. Verify before claiming success: run the tests or a smoke test. Use
   `/reload` to hot-reload auto-discovered extensions after editing them.

## Quick conventions

- **Auto-discovered extensions:** `~/.pi/agent/extensions/*.ts` (global) or
  `.pi/extensions/*.ts` (project). Test one-off with `pi -e ./file.ts`.
- **Skills:** `~/.pi/agent/skills/<name>/SKILL.md` (global) or
  `.pi/skills/<name>/SKILL.md` (project).
- **Prompt templates:** `~/.pi/agent/prompts/<name>.md` (global) or
  `.pi/prompts/<name>.md` (project).
- **Package assets:** always resolve via `src/config.ts` helpers
  (`getPackageDir`, `getThemeDir`, …) — never `__dirname` directly.
- **System prompt overrides:** `.pi/SYSTEM.md` / `~/.pi/agent/SYSTEM.md` replace
  the default; `APPEND_SYSTEM.md` in the same locations appends.
- **Toggling the built-in Pi docs block:** `/pi-docs on|off` (default OFF here);
  set `PI_KEEP_PI_DOCS=1` at launch to start with it ON.