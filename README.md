# mypi

My [pi coding agent](https://github.com/earendil-works/pi) packages, version-controlled.

## Contents

`.pi/` mirrors the global `~/.pi/agent/` layout so these assets are auto-discovered
when working inside this repo, and can be copied back to `~/.pi/agent/` to restore
a machine.

### Skills (`.pi/skills/<name>/SKILL.md`)
- **pi-development** — how to work on pi itself (extensions, skills, themes, prompts, SDK/RPC, providers, models, packages, settings).
- **tavily-search** — web search and page extraction via the Tavily API (requires `TAVILY_API_KEY`).

### Extensions (`.pi/extensions/*.ts`)
- **strip-pi-docs.ts** — strips the built-in "Pi documentation" block from the system prompt. Adds `/pi-docs on|off` (default OFF) and exports `PI_DOCS_DIR`, `PI_EXAMPLES_DIR`, `PI_README_PATH`.

## Restore to a new machine

```bash
cp -r .pi/skills/* ~/.pi/agent/skills/
cp .pi/extensions/*.ts ~/.pi/agent/extensions/
```