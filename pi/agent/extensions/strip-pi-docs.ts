/**
 * Strip Pi Docs Extension
 *
 * Removes the built-in "Pi documentation" block from the default system prompt
 * so the model does not carry those doc pointers in every turn. The equivalent
 * guidance lives in the `pi-development` skill, which loads on demand.
 *
 * Default: block stripped (OFF).
 * Turn the original block back on for a session:
 *   - launch with PI_KEEP_PI_DOCS=1, or
 *   - run `/pi-docs on` in the session (and `/pi-docs off` to hide it again).
 *
 * This extension also exports PI_DOCS_DIR / PI_EXAMPLES_DIR / PI_README_PATH to
 * the shell tools, so the pi-development skill can locate the docs exactly.
 *
 * Note: toggling mid-session changes the system prompt and therefore resets the
 * provider prompt-prefix cache for that turn. Prefer deciding at launch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getDocsPath,
	getExamplesPath,
	getReadmePath,
} from "@earendil-works/pi-coding-agent";

const MARKER = "Pi documentation (read only when";

// Current pi renders each system-prompt section wrapped in a matching tag, so
// the docs block is `<docs>\nPi documentation ...\n</docs>`. Strip the whole
// tagged section (tags included) when present, otherwise fall back to the older
// untagged header+bullets form. The lazy match stops at the first blank line,
// the trailing "Current working directory:" line, or end of prompt.
const DOCS_BLOCK_TAGGED = /\n*<docs>\nPi documentation \(read only when[\s\S]*?<\/docs>/;
const DOCS_BLOCK_LEGACY =
	/\n*Pi documentation \(read only when[\s\S]*?(?=\n\n|\nCurrent working directory:|$)/;

function stripDocsBlock(prompt: string): string {
	if (!prompt.includes(MARKER)) {
		return prompt;
	}
	const stripped = prompt
		.replace(DOCS_BLOCK_TAGGED, "")
		.replace(DOCS_BLOCK_LEGACY, "");
	// Collapse any blank-line runs left behind.
	return stripped.replace(/\n{3,}/g, "\n\n");
}

export default function (pi: ExtensionAPI) {
	// Let the pi-development skill (and the model's shell) find the docs exactly.
	process.env.PI_DOCS_DIR ??= getDocsPath();
	process.env.PI_EXAMPLES_DIR ??= getExamplesPath();
	process.env.PI_README_PATH ??= getReadmePath();

	let keepDocs = /^(1|true|yes)$/i.test(process.env.PI_KEEP_PI_DOCS ?? "");

	pi.registerCommand("pi-docs", {
		description:
			"Show or toggle the built-in Pi documentation block in the system prompt (on/off)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "on" && action !== "off") {
				ctx.ui.notify(
					`Pi docs block is ${keepDocs ? "ON" : "OFF"}. Use /pi-docs on|off to change it.`,
					"info",
				);
				return;
			}
			keepDocs = action === "on";
			ctx.ui.notify(
				`Pi docs block ${keepDocs ? "ON" : "OFF"} (applies next turn; changing it resets the prompt cache).`,
				"info",
			);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (keepDocs) {
			return;
		}
		const stripped = stripDocsBlock(event.systemPrompt);
		if (stripped === event.systemPrompt) {
			return;
		}
		return { systemPrompt: stripped };
	});
}