/**
 * Payload Inspector - shows what was ACTUALLY sent to the AI model.
 *
 * Usage:
 *   /payload            - list captured provider requests, pick one to inspect
 *   /payload last       - inspect the most recent request directly
 *
 * Keys:
 *   Picker:  up/down select, Enter open, Esc close
 *   Viewer:  up/down scroll, PgUp/PgDn page, Home/End jump, r toggle raw JSON,
 *            b back to list, Esc/q close
 *
 * Captures run through `before_provider_request`, i.e. the exact payload
 * pi is about to send over the wire (after system-prompt assembly, context
 * event mutations, and any payload rewrites).
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

type CapturedRequest = {
	id: number;
	timestamp: string;
	model: string;
	provider: string;
	payload: Record<string, unknown>;
	messageCount: number;
	systemChars: number;
	messagesChars: number;
	estTokens: number;
};

const buffer: CapturedRequest[] = [];
const MAX_CAPTURED = 3;
let nextId = 1;

const getContentLength = (content: unknown): number => {
	if (typeof content === "string") return content.length;
	if (Array.isArray(content)) {
		let n = 0;
		for (const block of content) {
			if (block && typeof block === "object") {
				const b = block as { text?: string };
				if (typeof b.text === "string") n += b.text.length;
			}
		}
		return n;
	}
	return 0;
};

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") return;

		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		let messagesChars = 0;
		for (const m of messages) {
			const msg = m as { content?: unknown };
			messagesChars += getContentLength(msg?.content);
		}

		let systemChars = 0;
		if (typeof payload.system === "string") systemChars = payload.system.length;
		else if (Array.isArray(payload.system)) systemChars = getContentLength(payload.system);

		const totalChars = systemChars + messagesChars;
		buffer.push({
			id: nextId++,
			timestamp: new Date().toLocaleTimeString(),
			model: typeof payload.model === "string" ? payload.model : ctx.model?.id ?? "?",
			provider: ctx.model?.provider ?? "?",
			payload,
			messageCount: messages.length,
			systemChars,
			messagesChars,
			estTokens: Math.round(totalChars / 4),
		});
		if (buffer.length > MAX_CAPTURED) buffer.shift();
	});

	// ---------------------------------------------------------------------------
	// Command
	// ---------------------------------------------------------------------------

	pi.registerCommand("payload", {
		description: "Inspect the exact context sent to the AI model",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (buffer.length === 0) {
				ctx.ui.notify("No requests captured yet. Send a message first.", "info");
				return;
			}

			let target: CapturedRequest | null = null;
			if (args.trim().startsWith("last")) {
				target = buffer[buffer.length - 1] ?? null;
			} else {
				const selection = await pickRequest(ctx);
				if (!selection) return;
				if (selection === "no-requests") return;
				target = selection;
			}
			if (!target) return;

			// Viewer loop: Esc/q closes, b returns to the picker
			let current = target;
			for (;;) {
				const result = await showViewer(ctx, current);
				if (result === "back") {
					const again = await pickRequest(ctx, current.id);
					if (!again || again === "no-requests") return;
					current = again;
					continue;
				}
				return;
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Picker overlay
// ---------------------------------------------------------------------------

async function pickRequest(
	ctx: ExtensionCommandContext,
	selectedId?: number,
): Promise<CapturedRequest | "no-requests" | null> {
	if (buffer.length === 0) {
		ctx.ui.notify("No requests captured yet. Send a message first.", "info");
		return "no-requests";
	}
	return ctx.ui.custom<CapturedRequest | null>(
		(_tui, theme, _keybindings, done) => new PickerComponent(theme, done, selectedId),
		{ overlay: true, overlayOptions: { width: "70%", minWidth: 60, maxHeight: "60%" } },
	);
}

class PickerComponent {
	focused = false;
	private selected: number;

	invalidate(): void {}

	constructor(
		private theme: Theme,
		private done: (r: CapturedRequest | null) => void,
		selectedId?: number,
	) {
		const idx = selectedId ? buffer.findIndex((r) => r.id === selectedId) : buffer.length - 1;
		this.selected = idx >= 0 ? idx : buffer.length - 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "return")) {
			this.done(buffer[this.selected] ?? null);
			return;
		}
		// Display is newest-first (reversed), so "up" means a higher buffer index.
		if (matchesKey(data, "up")) {
			this.selected = Math.min(buffer.length - 1, this.selected + 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.max(0, this.selected - 1);
		}
	}

	render(_width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		lines.push(` ${th.fg("accent", "Payload Inspector")} ${th.fg("dim", "- captured provider requests")}`);
		lines.push("");
		// Newest first for reading convenience
		for (let i = buffer.length - 1; i >= 0; i--) {
			const r = buffer[i]!;
			const isSel = i === this.selected;
			const marker = isSel ? th.fg("accent", ">") : " ";
			const label =
				`#${r.id} ${r.timestamp}  ${r.provider}/${r.model}` +
				`  ${r.messageCount} msgs  ~${r.estTokens} tok`;
			lines.push(`${marker} ${isSel ? th.fg("accent", label) : label}`);
		}
		lines.push("");
		lines.push(` ${th.fg("dim", "up/down select - Enter inspect - Esc close")}`);
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Viewer overlay
// ---------------------------------------------------------------------------

type Line = { text: string; kind: "role" | "meta" | "body" | "dim" };

async function showViewer(ctx: ExtensionCommandContext, request: CapturedRequest): Promise<"back" | null> {
	return ctx.ui.custom<"back" | null>(
		(tui, theme, _keybindings, done) => new ViewerComponent(theme, done, request, tui.terminal.rows),
		{ overlay: true, overlayOptions: { width: "90%", minWidth: 70, maxHeight: "90%" } },
	);
}

class ViewerComponent {
	focused = false;
	private offset = 0;

	invalidate(): void {}
	private raw = false;
	private width = -1;
	private prettyLines: Line[] = [];
	private rawLines: string[] = [];
	private builtRawWidth = -1;
	private builtPrettyWidth = -1;

	constructor(
		private theme: Theme,
		private done: (result: "back" | null) => void,
		private request: CapturedRequest,
		private termHeight: number,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "b")) {
			this.done("back");
			return;
		}
		if (matchesKey(data, "r")) {
			this.raw = !this.raw;
			this.offset = 0;
			this.rebuild();
			return;
		}

		const page = Math.max(1, this.viewportHeight() - 2);
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.offset = Math.min(this.maxOffset(), this.offset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.offset = Math.max(0, this.offset - page);
		} else if (matchesKey(data, "pageDown")) {
			this.offset = Math.min(this.maxOffset(), this.offset + page);
		} else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.offset = 0;
		} else if (matchesKey(data, "end") || matchesKey(data, Key.shift("g"))) {
			this.offset = this.maxOffset();
		}
	}

	private maxOffset(): number {
		return Math.max(0, this.currentContent().length - this.viewportHeight());
	}

	private viewportHeight(): number {
		// Overlay clips at maxHeight; leave room for border + header + footer
		return Math.max(5, Math.floor(this.termHeight * 0.9) - 8);
	}

	render(width: number): string[] {
		// tui is passed at construction? No - capture from render context is not
		// available, so store the height from the overlay via the factory.
		if (this.width !== width) {
			this.width = width;
			this.rebuild();
		}
		const th = this.theme;
		const innerW = width - 2;
		const vh = this.viewportHeight();
		const content = this.currentContent();

		const lines: string[] = [];
		const r = this.request;
		const header = `#${r.id} ${r.timestamp} ${r.provider}/${r.model} - ${r.messageCount} msgs - ~${r.estTokens} tokens`;
		const mode = this.raw ? th.fg("warning", "RAW") : th.fg("success", "PRETTY");
		lines.push(` ${th.fg("accent", "Sent to model")} ${th.fg("dim", header)}  ${mode}  ${th.fg("dim", `${this.offset + 1}/${Math.max(content.length, 1)}`)}`);
		lines.push(th.fg("border", "─".repeat(Math.max(1, innerW))));

		const slice = content.slice(this.offset, this.offset + vh);
		for (const line of slice) {
			const entry = line as Line | string;
			const text = typeof entry === "string" ? entry : entry.text;
			const kind = typeof entry === "string" ? "body" : entry.kind;
			const styled =
				kind === "role" ? th.fg("accent", text)
				: kind === "dim" ? th.fg("dim", text)
				: text;
			lines.push(truncateToWidth(styled, innerW, "…"));
		}
		while (lines.length < vh + 2) lines.push("");

		lines.push(
			` ${th.fg("dim", "up/down scroll - PgUp/PgDn page - r raw/pretty - b back - Esc close")}`,
		);
		return lines;
	}

	private currentContent(): (Line | string)[] {
		return this.raw ? this.rawLines : this.prettyLines;
	}

	private rebuild(): void {
		const w = Math.max(20, this.width - 2);
		if (this.raw) {
			if (this.builtRawWidth !== w) {
				this.rawLines = wrapTextWithAnsi(JSON.stringify(this.request.payload, null, 2), w);
				this.builtRawWidth = w;
			}
			return;
		}
		if (this.builtPrettyWidth !== w) {
			this.prettyLines = buildPrettyLines(this.theme, this.request, w);
			this.builtPrettyWidth = w;
		}
	}
}

// ---------------------------------------------------------------------------
// Pretty rendering of the payload
// ---------------------------------------------------------------------------

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
	content?: unknown;
	source?: { type?: string; media_type?: string };
	mimeType?: string;
};

const MAX_BLOCK_JSON = 400;

const blockPreview = (b: ContentBlock): string => {
	switch (b.type) {
		case "text":
			return typeof b.text === "string" ? b.text : "";
		case "thinking":
			return typeof b.thinking === "string" ? b.thinking : "";
		case "toolCall":
		case "tool_use": {
			const args = JSON.stringify(b.arguments ?? {});
			const argsText = args.length > MAX_BLOCK_JSON ? args.slice(0, MAX_BLOCK_JSON) + " …" : args;
			return `[tool call] ${b.name ?? "?"}(${argsText})`;
		}
		case "toolResult":
		case "tool_result": {
			const text = getContentLength(b.content) > 0
				? flattenContent(b.content)
				: "";
			const clipped = text.length > MAX_BLOCK_JSON ? text.slice(0, MAX_BLOCK_JSON) + " …" : text;
			return `[tool result]${b.id ? ` for ${b.id}` : ""}\n${clipped}`;
		}
		case "image": {
			const mt = b.source?.media_type ?? b.mimeType ?? "unknown";
			return `[image: ${mt}]`;
		}
		default: {
			const json = JSON.stringify(b);
			const clipped = json.length > MAX_BLOCK_JSON ? json.slice(0, MAX_BLOCK_JSON) + " …" : json;
			return `[${b.type ?? "unknown"}] ${clipped}`;
		}
	}
};

const flattenContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") parts.push(blockPreview(block as ContentBlock));
	}
	return parts.filter(Boolean).join("\n");
};

const flattenSystem = (system: unknown): string => {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) return flattenContent(system);
	return "";
};

function buildPrettyLines(th: Theme, request: CapturedRequest, width: number): Line[] {
	const lines: Line[] = [];
	const push = (text: string, kind: Line["kind"] = "body") => {
		for (const wrapped of wrapTextWithAnsi(text, width)) {
			lines.push({ text: wrapped, kind });
		}
	};

	const payload = request.payload;
	const systemText = flattenSystem(payload.system);

	if (systemText) {
		push("── System prompt ──", "role");
		push(systemText, "dim");
		push("", "meta");
	} else {
		// openai-completions style: system lives in messages
		const first = (Array.isArray(payload.messages) ? payload.messages[0] : undefined) as
			| { role?: string; content?: unknown }
			| undefined;
		if (first?.role === "system") {
			push("── System prompt (as first message) ──", "role");
			push(flattenContent(first.content), "dim");
			push("", "meta");
		}
	}

	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (!m || typeof m !== "object") continue;
		const role = String(m.role ?? "?");
		if (role === "system") continue; // already shown above
		const label =
			role === "user" ? "USER" : role === "assistant" ? "ASSISTANT" : role.toUpperCase();
		push(`── [${i}] ${label} ──`, "role");
		const text = flattenContent(m.content);
		push(text || JSON.stringify(m.content) || "(empty)", role === "assistant" ? "body" : "body");
		push("", "meta");
	}

	if (lines.length === 0) {
		push("No messages found in payload. Press r to view raw JSON.", "dim");
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
