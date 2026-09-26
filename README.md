# mypi

My [pi coding agent](https://github.com/earendil-works/pi) packages, version-controlled.

## Contents

The config directory here is named `pi/` (not `.pi/`) **on purpose**: pi
auto-discovers `.pi/` in the working directory, and this repo is only a
collection of pi assets — we don't want its skills/extensions loading every
time we run pi inside this repo. `pi/` still mirrors the global
`~/.pi/agent/` layout, so assets can be copied back to `~/.pi/agent/` to
restore a machine.

### Skills (`pi/skills/<name>/SKILL.md`)
- **pi-development** — how to work on pi itself (extensions, skills, themes, prompts, SDK/RPC, providers, models, packages, settings).
- **tavily-search** — web search and page extraction via the Tavily API (requires `TAVILY_API_KEY`).

### Extensions (`pi/extensions/*.ts`)
- **strip-pi-docs.ts** — strips the built-in "Pi documentation" block from the system prompt. Adds `/pi-docs on|off` (default OFF) and exports `PI_DOCS_DIR`, `PI_EXAMPLES_DIR`, `PI_README_PATH`.
- **provider-payload.ts** — logs every provider request/response payload to `<cwd>/.pi/provider-payload.log` for debugging.

## Restore to a new machine

```bash
cp -r pi/skills/* ~/.pi/agent/skills/
cp pi/extensions/*.ts ~/.pi/agent/extensions/
```