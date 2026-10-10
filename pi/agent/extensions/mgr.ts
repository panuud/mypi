/**
 * mgr — toggle skills/extensions on/off (batch).
 *
 * Enabled items live in ~/.pi/agent/skills and ~/.pi/agent/extensions.
 * Disabled items live in ~/.pi/agent/unused/skills and ~/.pi/agent/unused/extensions.
 *
 * /mgr opens a multi-select list:
 *   ↑/↓ move   space toggle pending change   enter apply (moves files, reloads)   esc cancel
 * All pending moves are applied in one go, then a single runtime reload.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SELF = "mgr.ts";
const EXT_ENTRY_RE = /\.(ts|js|mjs|cjs)$/;

interface Item {
	name: string;
	kind: "skill" | "extension";
	enabled: boolean;
	from: string;
	to: string;
	isSelf: boolean;
	toggled: boolean;
}

/** Does this entry look like a loadable skill? */
function isSkillEntry(entry: fs.Dirent, full: string): boolean {
	if (entry.isDirectory()) return fs.existsSync(path.join(full, "SKILL.md"));
	return entry.isFile() && entry.name.toLowerCase().endsWith(".md");
}

/** Does this entry look like a loadable extension? */
function isExtensionEntry(entry: fs.Dirent, full: string): boolean {
	if (entry.isFile()) return EXT_ENTRY_RE.test(entry.name);
	if (entry.isDirectory()) {
		return ["index.ts", "index.js", "index.mjs", "index.cjs"].some((f) =>
			fs.existsSync(path.join(full, f)),
		);
	}
	return false;
}

function scan(
	dir: string,
	kind: "skill" | "extension",
	enabled: boolean,
	destDir: string,
	out: Item[],
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const full = path.join(dir, e.name);
		const ok = kind === "skill" ? isSkillEntry(e, full) : isExtensionEntry(e, full);
		if (!ok) continue;
		out.push({
			name: e.name,
			kind,
			enabled,
			from: full,
			to: path.join(destDir, e.name),
			isSelf: e.name === SELF,
			toggled: false,
		});
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("mgr", {
		description: "Toggle skills/extensions on/off (batch select, then applies and reloads)",
		handler: async (_args, ctx) => {
			const agentDir = path.join(os.homedir(), ".pi", "agent");
			const skillsDir = path.join(agentDir, "skills");
			const extsDir = path.join(agentDir, "extensions");
			const unusedDir = path.join(agentDir, "unused");
			const unusedSkills = path.join(unusedDir, "skills");
			const unusedExts = path.join(unusedDir, "extensions");

			const items: Item[] = [];
			scan(skillsDir, "skill", true, unusedSkills, items);
			scan(extsDir, "extension", true, unusedExts, items);
			scan(unusedSkills, "skill", false, skillsDir, items);
			scan(unusedExts, "extension", false, extsDir, items);
			items.sort((a, b) =>
				a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind),
			);

			if (items.length === 0) {
				ctx.ui.notify("No skills or extensions found.", "info");
				return;
			}

			const result = await ctx.ui.custom<{ apply: boolean }>((tui, theme, _kb, done) => {
				let cursor = 0;
				let scroll = 0;
				let cachedLines: string[] | undefined;

				const pendingCount = () => items.filter((i) => i.toggled).length;

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(apply: boolean) {
					done({ apply });
				}

				function handleInput(data: string) {
					if (matchesKey(data, Key.up)) {
						cursor = Math.max(0, cursor - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						cursor = Math.min(items.length - 1, cursor + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.pageUp)) {
						cursor = Math.max(0, cursor - 10);
						refresh();
						return;
					}
					if (matchesKey(data, Key.pageDown)) {
						cursor = Math.min(items.length - 1, cursor + 10);
						refresh();
						return;
					}
					if (matchesKey(data, Key.space)) {
						items[cursor].toggled = !items[cursor].toggled;
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						submit(true);
						return;
					}
					if (matchesKey(data, Key.escape)) {
						submit(false);
						return;
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const w = Math.max(20, width);
					const lines: string[] = [];

					// Keep cursor visible with a small scroll window.
					const bodyRows = Math.max(3, items.length + 1);
					if (cursor < scroll) scroll = cursor;
					if (cursor > scroll + bodyRows - 1) scroll = cursor - bodyRows + 1;
					if (scroll < 0) scroll = 0;

					lines.push(theme.fg("accent", "─".repeat(w)));
					lines.push(
						theme.fg("text", ` Toggle skills / extensions (${pendingCount()} pending) `),
					);
					lines.push(theme.fg("accent", "─".repeat(w)));

					for (let i = 0; i < items.length; i++) {
						const item = items[i];
						const selected = i === cursor;
						const box = item.enabled ? "[x]" : "[ ]";
						const state = item.enabled ? "enabled" : "disabled";
						const action = item.toggled
							? item.enabled
								? "→ disable"
								: "→ enable"
							: "";
						const self = item.isSelf ? " (mgr)" : "";
						const label = ` ${box} ${item.name} (${item.kind}, ${state})${self} ${action}`;

						let styled: string;
						if (item.toggled) {
							styled = theme.fg("warning", label);
						} else {
							styled = theme.fg(selected ? "accent" : "muted", label);
						}
						if (selected) {
							styled = theme.bg("selectedBg", theme.fg("text", truncateToWidth(label, w)));
						}
						lines.push(truncateToWidth(styled, w));
					}

					lines.push("");
					lines.push(
						truncateToWidth(
							theme.fg(
								"muted",
								" ↑/↓ move · space toggle · enter apply & reload · esc cancel",
							),
							w,
						),
					);
					lines.push(theme.fg("accent", "─".repeat(w)));

					cachedLines = lines;
					return lines;
				}

				return { render, handleInput };
			});

			if (!result?.apply) return;

			const pending = items.filter((i) => i.toggled);
			if (pending.length === 0) {
				ctx.ui.notify("No changes selected.", "info");
				return;
			}

			// Confirm when the manager would disable itself.
			if (pending.some((i) => i.isSelf && i.enabled)) {
				const selfItem = pending.find((i) => i.isSelf)!;
				const ok = await ctx.ui.confirm(
					"Disabling the manager",
					`/mgr will be unavailable after this. To re-enable later, start pi with:\n\n  pi --extension ${selfItem.to}\n\nApply all ${pending.length} change(s) anyway?`,
				);
				if (!ok) return;
			}

			const moved: string[] = [];
			const failed: string[] = [];
			for (const item of pending) {
				try {
					fs.mkdirSync(path.dirname(item.to), { recursive: true });
					fs.renameSync(item.from, item.to);
					moved.push(
						`${item.name} (${item.kind}) ${item.enabled ? "disabled" : "enabled"}`,
					);
				} catch (err) {
					failed.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			if (moved.length > 0) {
				ctx.ui.notify(`${moved.length} change(s) applied — reloading…`, "info");
			}
			if (failed.length > 0) {
				ctx.ui.notify(`Some moves failed: ${failed.join("; ")}`, "error");
				return; // don't reload on partial failure
			}

			// Reload is terminal for this handler: the runtime is replaced.
			await ctx.reload();
		},
	});
}
