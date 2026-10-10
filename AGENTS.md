# Agent.md

This repo is just a version-controlled collection of my [pi coding agent](https://github.com/earendil-works/pi) resources. That's its only purpose.

It is **not** a software project. There's no build, no tests, no app to run. It holds my pi assets so they can be backed up, reviewed, and restored on any machine.

## Structure

- `pi/` — mirrors the global `~/.pi/` config directory.
  - `pi/agent/` — mirrors `~/.pi/agent/`, including disabled assets:
    - `pi/agent/skills/<name>/SKILL.md` — enabled pi skills.
    - `pi/agent/extensions/*` — enabled pi extensions.
    - `pi/agent/unused/skills/` — disabled skills (managed by the **mgr** extension).
    - `pi/agent/unused/extensions/` — disabled extensions (managed by the **mgr** extension).
- `README.md` — human-readable summary of the contents.

A full restore therefore also restores disabled items in the exact layout the
mgr extension expects; it toggles items by moving files between the enabled
directories and `unused/`.

The config directory is named `pi/` (not `.pi/`) **on purpose**: pi auto-discovers `.pi/` in the working directory, and we don't want this repo's skills/extensions loading every time pi runs inside this repo.

## Notes for agents working here

- Do not add a build system, package manager, or CI unless explicitly asked.
- Keep assets in the `pi/agent/` mirror layout so they can be copied back to `~/.pi/agent/`.
- When adding a skill or extension, update `README.md` too.
- Treat this as a config/resource repo, not an application.
