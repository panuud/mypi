# Agent.md

This repo is just a version-controlled collection of my [pi coding agent](https://github.com/earendil-works/pi) resources. That's its only purpose.

It is **not** a software project. There's no build, no tests, no app to run. It holds my pi assets so they can be backed up, reviewed, and restored on any machine.

## Structure

- `pi/` — mirrors the global `~/.pi/` config directory.
  - `pi/agent/` — mirrors `~/.pi/agent/`.
    - `pi/agent/skills/<name>/SKILL.md` — pi skills.
    - `pi/agent/extensions/*.ts` — pi extensions.
- `unused/` — kept assets that are not loaded (outside the mirror, so restore does not copy them).
- `README.md` — human-readable summary of the contents.

The config directory is named `pi/` (not `.pi/`) **on purpose**: pi auto-discovers `.pi/` in the working directory, and we don't want this repo's skills/extensions loading every time pi runs inside this repo.

## Notes for agents working here

- Do not add a build system, package manager, or CI unless explicitly asked.
- Keep assets in the `pi/agent/` mirror layout so they can be copied back to `~/.pi/agent/`.
- When adding a skill or extension, update `README.md` too.
- Treat this as a config/resource repo, not an application.
