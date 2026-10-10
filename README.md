# mypi

My [pi coding agent](https://github.com/earendil-works/pi) packages, version-controlled.

## Contents

The config directory here is named `pi/` (not `.pi/`) **on purpose**: pi
auto-discovers `.pi/` in the working directory, and this repo is only a
collection of pi assets — we don't want its skills/extensions loading every
time we run pi inside this repo. `pi/` mirrors the global `~/.pi/` config
directory (so `pi/agent/` mirrors `~/.pi/agent/`), and assets can be copied
back to restore a machine.

### Skills (`pi/agent/skills/<name>/SKILL.md`)
- **tavily-search** — web search and page extraction via the Tavily API (requires `TAVILY_API_KEY`).

### Extensions (`pi/agent/extensions/*`)
- **mgr.ts** — toggle skills/extensions on/off in batch (`/mgr`): multi-select list, moves files between the enabled directories and `~/.pi/agent/unused/{skills,extensions}/`, then reloads in one go.
- **strip-pi-docs.ts** — strips the built-in "Pi documentation" block from the system prompt. Adds `/pi-docs on|off` (default OFF) and exports `PI_DOCS_DIR`, `PI_EXAMPLES_DIR`, `PI_README_PATH`.
- **subagent.ts** — adds the `subagent` tool to delegate tasks to isolated, inline-configured subagents (single or parallel, max 8 tasks / 4 concurrent). Spawns a separate `pi` process per subagent so each gets its own context window; recursion is blocked in child processes.
- **payload-inspector.ts** — adds `/payload` to inspect the exact context sent to the model (last request, or pick from a list). Pretty/raw JSON viewer with scroll, search-free pager UI. Captures via `before_provider_request`.
- **subagent.ts** — adds the `subagent` tool to delegate tasks to isolated, inline-configured subagents (single or parallel, max 8 tasks / 4 concurrent). Spawns a separate `pi` process per subagent so each gets its own context window; recursion is blocked in child processes.

### Scripts (repo root)
- **launcher.py** (`pif`) — fuzzy launcher for pi sessions: pick a working directory (from session history), then resume one of its sessions or start a new one there; `+` entries also allow starting a session in a directory with no history.

### Disabled (`pi/agent/unused/`)
Managed by the **mgr** extension (toggling moves files between the enabled
directories and these `unused/` folders, then reloads).

- **extensions/payload-inspector.ts** — adds `/payload` to inspect the exact context sent to the model (last request, or pick from a list). Pretty/raw JSON viewer with scroll, search-free pager UI. Captures via `before_provider_request`.
- **skills/pi-development** — how to work on pi itself (extensions, skills, themes, prompts, SDK/RPC, providers, models, packages, settings).

## Restore to a new machine

```bash
cp -r pi/agent/* ~/.pi/agent/
```

This also restores disabled items under `~/.pi/agent/unused/`, exactly where
mgr expects them.
