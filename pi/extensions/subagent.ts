/**
 * Subagent Tool - Delegate tasks to generic, inline-configured subagents
 *
 * Spawns a separate `pi` process per subagent invocation, giving it an isolated
 * context window. There are no predefined agents: the dispatcher defines each
 * subagent inline via `task` plus optional `systemPrompt`, `tools`, `model`,
 * `thinkingLevel`, and `cwd`.
 *
 * Modes:
 *   - Single:   { task, ...options }
 *   - Parallel: { tasks: [{ task, ...options }, ...] }  (max 8, 4 concurrent)
 *
 * Recursion is blocked at three layers:
 *   1. Child processes get PI_SUBAGENT_CHILD=1, and this extension refuses to
 *      register the tool when that variable is set.
 *   2. Child processes are spawned with `-xt subagent`.
 *   3. "subagent" is stripped from any dispatcher-supplied tool allowlist.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const TOOL_NAME = "subagent";
const BLOCKED_TOOL_NAMES = new Set([TOOL_NAME, "subagents"]);
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const FRAMING_PROMPT = [
	"You are a focused subagent executing a task delegated by another agent.",
	"Work autonomously to complete the task, then report clear, concise results.",
	"You cannot delegate further: there is no subagent tool available to you.",
].join("\n");

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function previewText(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			return themeFg("muted", "$ ") + themeFg("toolOutput", previewText(command, 60));
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", shortenPath(rawPath));
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const lineCount = ((args.content || "") as string).split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
			if (lineCount > 1) text += themeFg("dim", ` (${lineCount} lines)`);
			return text;
		}
		case "edit":
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath((args.file_path || args.path || "...") as string));
		case "ls":
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return (
				themeFg("muted", "find ") +
				themeFg("accent", (args.pattern || "*") as string) +
				themeFg("dim", ` in ${shortenPath((args.path || ".") as string)}`)
			);
		case "grep":
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${(args.pattern || "") as string}/`) +
				themeFg("dim", ` in ${shortenPath((args.path || ".") as string)}`)
			);
		default:
			return themeFg("accent", toolName) + themeFg("dim", ` ${previewText(JSON.stringify(args), 50)}`);
	}
}

// ── Types ───────────────────────────────────────────────────────────────────

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface TaskSpec {
	task: string;
	systemPrompt?: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	cwd?: string;
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface SingleResult {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function sanitizeTools(tools: string[] | undefined): { kept: string[]; removed: string[] } {
	const kept: string[] = [];
	const removed: string[] = [];
	for (const raw of tools ?? []) {
		const name = raw.trim();
		if (!name) continue;
		if (BLOCKED_TOOL_NAMES.has(name)) removed.push(name);
		else kept.push(name);
	}
	return { kept, removed };
}

/** Collects blocked tool names the dispatcher asked for, across single and parallel specs. */
function collectRemovedTools(params: { tools?: string[]; tasks?: { tools?: string[] }[] }): string[] {
	const removed = new Set<string>();
	for (const name of sanitizeTools(params.tools).removed) removed.add(name);
	for (const task of params.tasks ?? []) for (const name of sanitizeTools(task.tools).removed) removed.add(name);
	return Array.from(removed);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

// ── Subagent process ────────────────────────────────────────────────────────

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	spec: TaskSpec,
	label: string,
	mode: "single" | "parallel",
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SingleResult> {
	const makeDetails = (results: SingleResult[]): SubagentDetails => ({ mode, results });
	const currentResult: SingleResult = {
		task: spec.task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	const { kept } = sanitizeTools(spec.tools);
	const model = spec.model ?? dispatchDefaults.model;

	const args: string[] = ["--mode", "json", "-p", "--no-session", "-xt", TOOL_NAME];
	if (model) args.push("--model", model);
	if (spec.model) {
		if (spec.thinkingLevel) args.push("--thinking", spec.thinkingLevel);
	} else {
		const thinking = spec.thinkingLevel ?? dispatchDefaults.thinkingLevel;
		if (thinking) args.push("--thinking", thinking);
	}
	if (kept.length > 0) args.push("--tools", kept.join(","));

	let tmpDir: string | null = null;
	try {
		const prompt = spec.systemPrompt?.trim()
			? `${FRAMING_PROMPT}\n\n${spec.systemPrompt.trim()}`
			: FRAMING_PROMPT;
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const promptPath = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
		args.push(`Task: ${spec.task}`);

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: spec.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [CHILD_ENV]: "1" },
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				currentResult.stderr += `\nFailed to start subagent process: ${err instanceof Error ? err.message : String(err)}`;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error(`${label} was aborted`);
		return currentResult;
	} finally {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const TaskSpecSchema = {
	task: Type.String({
		description:
			"Task for the subagent. Be specific and self-contained: the subagent does not see this conversation.",
	}),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Extra instructions appended to the subagent's system prompt. Use it to define its role, constraints, and expected output format.",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Tool allowlist for the subagent, for example ["read","grep","find","ls"]. Omit to inherit the default tool selection. The subagent tool is always removed.',
		}),
	),
	model: Type.Optional(
		Type.String({ description: 'Model override as "provider/model-id". Defaults to the current model.' }),
	),
	thinkingLevel: Type.Optional(
		StringEnum(THINKING_LEVELS, { description: "Thinking level override. Defaults to the current thinking level." }),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the subagent process. Defaults to the current directory." }),
	),
};

const SubagentParams = Type.Object({
	...TaskSpecSchema,
	tasks: Type.Optional(
		Type.Array(Type.Object(TaskSpecSchema), {
			description: `Run these tasks in parallel (max ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} concurrent). Provide either task or tasks, not both.`,
		}),
	),
});

// ── Extension ───────────────────────────────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI) {
	// Layer 1: never register inside a subagent child process.
	if (process.env[CHILD_ENV]) return;

	pi.registerTool({
		name: TOOL_NAME,
		label: "Subagent",
		description: [
			"Delegate a task to a subagent running in an isolated pi process with its own context window.",
			"Define the subagent inline: task is required; systemPrompt, tools, model, thinkingLevel, and cwd are optional.",
			`Modes: single (task) or parallel (tasks array, max ${MAX_PARALLEL_TASKS} tasks, ${MAX_CONCURRENCY} concurrent).`,
			"Subagents cannot spawn further subagents.",
		].join(" "),
		promptSnippet: "Delegate tasks to isolated subagents.",
		promptGuidelines: [
			"Use subagent for independent, context-heavy work (broad searches, focused implementation, verification) so the main context stays clean.",
			"Give every subagent a self-contained task and set systemPrompt to define its role, constraints, and expected output.",
			"Subagents cannot delegate further; never instruct them to spawn more subagents.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
			const emptyDetails: SubagentDetails = { mode: "single", results: [] };

			if (hasTasks && hasSingle) {
				return {
					content: [{ type: "text", text: "Provide either task (single) or tasks (parallel), not both." }],
					details: emptyDetails,
					isError: true,
				};
			}
			if (!hasTasks && !hasSingle) {
				return {
					content: [{ type: "text", text: "Provide task (single) or tasks (parallel)." }],
					details: emptyDetails,
					isError: true,
				};
			}

			const removedTools = collectRemovedTools(params);
			const blockedNote =
				removedTools.length > 0
					? `Note: removed ${removedTools.map((n) => `"${n}"`).join(", ")} from the tools list; nested subagents are disabled.`
					: undefined;
			const withNote = (text: string) => (blockedNote ? `${blockedNote}\n\n${text}` : text);

			if (hasTasks) {
				const tasks = params.tasks ?? [];
				if (tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` },
						],
						details: { mode: "parallel", results: [] },
						isError: true,
					};
				}

				const allResults: SingleResult[] = tasks.map((t) => ({
					task: t.task,
					exitCode: -1, // -1 = still running
					messages: [],
					stderr: "",
					usage: emptyUsage(),
				}));

				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: { mode: "parallel", results: [...allResults] },
					});
				};

				const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						t,
						`task ${index + 1}`,
						"parallel",
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r, index) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### Task ${index + 1} — ${status}\n\n${output}`;
				});

				return {
					content: [
						{
							type: "text",
							text: withNote(
								`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
							),
						},
					],
					details: { mode: "parallel", results },
				};
			}

			const result = await runSingleAgent(
				ctx.cwd,
				dispatchDefaults,
				{
					task: params.task as string,
					systemPrompt: params.systemPrompt,
					tools: params.tools,
					model: params.model,
					thinkingLevel: params.thinkingLevel,
					cwd: params.cwd,
				},
				TOOL_NAME,
				"single",
				signal,
				onUpdate,
			);
			const details: SubagentDetails = { mode: "single", results: [result] };

			if (isFailedResult(result)) {
				const reason = result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : "";
				return {
					content: [{ type: "text", text: withNote(`Subagent failed${reason}: ${getResultOutput(result)}`) }],
					details,
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: withNote(getFinalOutput(result.messages) || "(no output)") }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
				for (let i = 0; i < Math.min(args.tasks.length, 3); i++) {
					text += `\n  ${theme.fg("accent", `task ${i + 1}`)}${theme.fg("dim", ` ${previewText(args.tasks[i].task, 50)}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			let text = theme.fg("toolTitle", theme.bold(TOOL_NAME));
			if (args.model) text += theme.fg("muted", ` [${args.model}]`);
			const toolCount = args.tools ? sanitizeTools(args.tools).kept.length : 0;
			if (toolCount > 0) text += theme.fg("muted", ` [tools:${toolCount}]`);
			text += `\n  ${theme.fg("dim", previewText(args.task || "...", 70))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const renderItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = skipped > 0 ? `${theme.fg("muted", `... ${skipped} earlier items\n`)}` : "";
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single") {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					for (const item of items) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
					}
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
					const usage = formatUsageStats(r.usage, r.model);
					if (usage) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usage), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (items.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderItems(items, COLLAPSED_ITEM_COUNT)}`;
					if (items.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usage = formatUsageStats(r.usage, r.model);
				if (usage) text += `\n${theme.fg("dim", usage)}`;
				return new Text(text, 0, 0);
			}

			// Parallel
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
			const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
			const isRunning = running > 0;
			const icon = isRunning
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunning
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} tasks`;

			if (expanded && !isRunning) {
				const container = new Container();
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `))}${theme.fg("accent", status)}`,
						0,
						0,
					),
				);
				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", `─── Task ${i + 1} `) + rIcon, 0, 0));
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					for (const item of getDisplayItems(r.messages)) {
						if (item.type === "toolCall")
							container.addChild(
								new Text(
									theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
									0,
									0,
								),
							);
					}
					if (isFailedResult(r) && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					const finalOutput = getFinalOutput(r.messages);
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
					const usage = formatUsageStats(r.usage, r.model);
					if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
				}
				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
				}
				return container;
			}

			let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `))}${theme.fg("accent", status)}`;
			for (let i = 0; i < details.results.length; i++) {
				const r = details.results[i];
				const rIcon =
					r.exitCode === -1
						? theme.fg("warning", "⏳")
						: isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
				const items = getDisplayItems(r.messages);
				text += `\n\n${theme.fg("muted", `─── Task ${i + 1} `)}${rIcon}`;
				if (items.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				else text += `\n${renderItems(items, 5)}`;
			}
			if (!isRunning) {
				const totalUsage = formatUsageStats(aggregateUsage(details.results));
				if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
