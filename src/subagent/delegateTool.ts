import * as vscode from "vscode";
import { logger } from "../logger";
import { VENDOR_MODES } from "../vendorModes";

/**
 * `delegateTask` language-model tool: runs a focused sub-task on a separate
 * model in a FRESH context and returns only its final report, so the main
 * chat's context window is not filled with exploration noise. The subagent
 * gets read-only workspace tools by default (it can search and read but not
 * edit), loops on tool calls up to a step budget, and must end with a concise
 * report. Pick a cheap/fast model for scouting and a strong one for analysis.
 */

export interface DelegateTaskInput {
	/** Self-contained task description with all context the subagent needs. */
	task: string;
	/** What the final report must contain (format, level of detail). */
	expectedOutput?: string;
	/** Model hint: an id/name substring, or "fast" / "strong". Default: the configured subagent model. */
	model?: string;
	/** Allow tools that can modify the workspace (edits, terminal). Default false. */
	allowWrite?: boolean;
	/** Max tool-calling rounds (default from settings, hard cap 40). */
	maxSteps?: number;
}

const OWN_VENDORS = new Set(VENDOR_MODES.map((v) => v.vendor));
const HARD_MAX_STEPS = 40;
const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_REPORT_CHARS = 60_000;

/** Tool-name fragments that are safe for a read-only subagent. */
const READ_ONLY_HINTS = [
	"read",
	"search",
	"grep",
	"find",
	"list",
	"get",
	"fetch",
	"semantic",
	"codebase",
	"usages",
	"symbol",
	"errors",
	"problems",
	"diagnostic",
	"view",
	"open",
	"lookup",
];
/** Fragments that indicate side effects; these win over READ_ONLY_HINTS. */
const WRITE_HINTS = [
	"edit",
	"write",
	"create",
	"delete",
	"remove",
	"rename",
	"replace",
	"insert",
	"apply",
	"patch",
	"run",
	"terminal",
	"exec",
	"install",
	"commit",
	"push",
	"move",
	"send",
	"kill",
	"task",
	"notebook",
	"delegate",
	"subagent",
];

function isReadOnlyTool(tool: vscode.LanguageModelToolInformation): boolean {
	const name = tool.name.toLowerCase();
	if (WRITE_HINTS.some((h) => name.includes(h))) {
		return false;
	}
	return READ_ONLY_HINTS.some((h) => name.includes(h));
}

function pickTools(allowWrite: boolean): vscode.LanguageModelChatTool[] {
	return vscode.lm.tools
		.filter((t) => t.name !== "customcopilot_delegateTask" && !/delegate|subagent|runSubagent/i.test(t.name))
		.filter((t) => allowWrite || isReadOnlyTool(t))
		.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));
}

async function selectModel(hint: string | undefined): Promise<vscode.LanguageModelChat | undefined> {
	const config = vscode.workspace.getConfiguration();
	const configured = (config.get<string>("customcopilot.subagent.model", "") || "").trim();
	const wanted = (hint ?? "").trim().toLowerCase();
	const all = await vscode.lm.selectChatModels();
	if (all.length === 0) {
		return undefined;
	}
	const ours = all.filter((m) => OWN_VENDORS.has(m.vendor));
	const byText = (needle: string) =>
		[...ours, ...all].find((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));

	if (wanted && wanted !== "fast" && wanted !== "strong") {
		const m = byText(wanted);
		if (m) {
			return m;
		}
	}
	if (configured) {
		const m = byText(configured.toLowerCase());
		if (m) {
			return m;
		}
	}
	const pool = ours.length > 0 ? ours : all;
	if (wanted === "fast") {
		const fast = pool.find((m) => /flash|mini|haiku|air|turbo|lite|nano|small/i.test(`${m.id} ${m.name}`));
		if (fast) {
			return fast;
		}
	}
	// Largest context window ≈ strongest when nothing else is known.
	return [...pool].sort((a, b) => b.maxInputTokens - a.maxInputTokens)[0];
}

function toolResultToText(result: vscode.LanguageModelToolResult): string {
	let text = "";
	for (const part of result.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		} else if (part instanceof vscode.LanguageModelPromptTsxPart) {
			text += JSON.stringify(part.value);
		}
	}
	return text.length > MAX_TOOL_RESULT_CHARS
		? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
		: text;
}

const SYSTEM_PROMPT = [
	"You are a focused subagent working for a coding assistant inside VS Code.",
	"You run in a fresh context: you only know what the task below tells you plus what you discover with tools.",
	"Work autonomously — never ask questions. Use the available tools to gather facts; prefer targeted searches over reading whole files.",
	"Do not modify anything unless the task explicitly allows it and write tools are available.",
	"Finish with a single final message that is the report for the main agent: concise, factual, with exact file paths and line numbers where relevant.",
	"Do not include your intermediate reasoning or tool logs in the report.",
].join("\n");

export class DelegateTaskTool implements vscode.LanguageModelTool<DelegateTaskInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateTaskInput>
	): Promise<vscode.PreparedToolInvocation> {
		const task = (options.input.task ?? "").trim();
		const short = task.length > 120 ? `${task.slice(0, 117)}…` : task;
		const base = { invocationMessage: `Subagent: ${short}` };
		if (options.input.allowWrite) {
			return {
				...base,
				confirmationMessages: {
					title: "Allow subagent to modify the workspace?",
					message: new vscode.MarkdownString(
						`The subagent will get **write tools** (edits / terminal) for this task:\n\n> ${short}`
					),
				},
			};
		}
		return base;
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<DelegateTaskInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const input = options.input;
		const task = (input.task ?? "").trim();
		if (!task) {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Error: `task` is required.")]);
		}
		const config = vscode.workspace.getConfiguration();
		const defaultSteps = Math.max(1, config.get<number>("customcopilot.subagent.maxSteps", 15));
		const maxSteps = Math.min(HARD_MAX_STEPS, Math.max(1, Math.floor(input.maxSteps ?? defaultSteps)));
		const allowWrite = input.allowWrite === true;

		const model = await selectModel(input.model);
		if (!model) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart("Error: no language model is available for the subagent."),
			]);
		}
		const tools = pickTools(allowWrite);
		const started = Date.now();
		logger.info("subagent.start", { model: model.id, tools: tools.length, maxSteps, allowWrite });

		const userPrompt = [
			`# Task\n${task}`,
			input.expectedOutput ? `# Expected report\n${input.expectedOutput}` : "",
			`# Limits\nAt most ${maxSteps} tool rounds. ${allowWrite ? "Write tools are available." : "Read-only: you cannot modify files."}`,
		]
			.filter(Boolean)
			.join("\n\n");

		const messages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(`${SYSTEM_PROMPT}\n\n${userPrompt}`),
		];

		let finalText = "";
		let steps = 0;
		let toolCalls = 0;
		try {
			for (;;) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const lastRound = steps >= maxSteps;
				const response = await model.sendRequest(
					messages,
					{
						justification: "Subagent delegated by the main chat",
						tools: lastRound || tools.length === 0 ? undefined : tools,
					},
					token
				);
				let text = "";
				const calls: vscode.LanguageModelToolCallPart[] = [];
				for await (const part of response.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						text += part.value;
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						calls.push(part);
					}
				}
				if (calls.length === 0) {
					finalText = text;
					break;
				}
				steps++;
				messages.push(vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]));
				const results: vscode.LanguageModelToolResultPart[] = [];
				for (const call of calls) {
					toolCalls++;
					let resultText: string;
					try {
						const r = await vscode.lm.invokeTool(
							call.name,
							{ input: call.input, toolInvocationToken: options.toolInvocationToken },
							token
						);
						resultText = toolResultToText(r) || "(empty result)";
					} catch (err) {
						if (err instanceof vscode.CancellationError) {
							throw err;
						}
						resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
					}
					results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(resultText)]));
				}
				const nudge =
					steps >= maxSteps
						? [new vscode.LanguageModelTextPart("Step budget reached. Write your final report now, without calling tools.")]
						: [];
				messages.push(vscode.LanguageModelChatMessage.User([...results, ...nudge]));
			}
		} catch (err) {
			if (err instanceof vscode.CancellationError) {
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn("subagent.error", { model: model.id, error: msg });
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Subagent failed after ${steps} rounds (${model.name}): ${msg}`),
			]);
		}

		const report = finalText.trim() || "(the subagent returned an empty report)";
		const trimmed = report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n…[report truncated]` : report;
		logger.info("subagent.done", { model: model.id, steps, toolCalls, ms: Date.now() - started, chars: trimmed.length });
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`[Subagent report — ${model.name}, ${steps} rounds, ${toolCalls} tool calls]\n\n${trimmed}`),
		]);
	}
}
