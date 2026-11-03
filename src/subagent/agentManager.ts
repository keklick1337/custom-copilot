import * as vscode from "vscode";
import { logger } from "../logger";
import { isMainChatIdle } from "../chatActivity";
import { AGENT_TOOL_NAMES } from "./agentNames";
import { HARD_MAX_STEPS, pickTools, selectModel } from "./agentSetup";
import { agentCreateFile, agentEditFile, agentRunCommand } from "./agentWriteTools";

/**
 * Background subagents (Claude Code style).
 *
 * The main chat starts an agent with `#delegate` and gets control back
 * immediately; the agent runs its own tool loop on the main chat's model
 * (the exact config — `provider:idx:id::configId`) in a fresh context.
 * Agents can start their own sub-agents (up to `customcopilot.subagent.maxDepth`),
 * which inherit the parent's model. While agents run:
 * - the main agent and the agents exchange messages (`sendAgentMessage`) —
 *   an agent receives its inbox at the start of its next round;
 * - anyone can list the agents (`listAgents`);
 * - a finished agent reports to its PARENT: a sub-agent's report lands in the
 *   parent agent's inbox; a top-level agent's report becomes a notification
 *   for the main agent. A main agent blocked in `waitForAgents` wakes up at
 *   once; if the main chat turn has already ended, the report is posted as a
 *   new message to the chat SESSION that started the agent (auto-resume);
 *   otherwise a short notice is injected into the main agent's next model
 *   request until the notification is read.
 */

export { AGENT_TOOL_NAMES } from "./agentNames";

/** Our extension id (`publisher.name`) — the `requestInitiator` of subagent model requests. */
export const EXTENSION_ID = "keklick1337.keklick-copilot";

/** Address of the main chat agent in messages. */
export const MAIN_AGENT = "main";

const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_REPORT_CHARS = 60_000;
/** Finished agents kept for listing / reading. */
const MAX_FINISHED_AGENTS = 50;
/** Report characters inlined into an auto-resume chat message. */
const AUTO_RESUME_REPORT_CHARS = 12_000;

export type AgentStatus = "running" | "done" | "failed" | "stopped";

export interface AgentMessage {
	from: string;
	text: string;
	at: number;
}

export interface AgentNotification {
	kind: "finished" | "message";
	agentId: string;
	agentName: string;
	text: string;
	at: number;
	/** Chat session (URI string) to post this to on auto-resume. */
	session?: string;
	/** Never auto-resume the chat for it (user stopped the agent). */
	quiet?: boolean;
}

export interface AgentRecord {
	id: string;
	name: string;
	task: string;
	expectedOutput?: string;
	modelId: string;
	modelName: string;
	status: AgentStatus;
	allowWrite: boolean;
	maxSteps: number;
	steps: number;
	toolCalls: number;
	startedAt: number;
	endedAt?: number;
	report?: string;
	error?: string;
	/** Short "currently doing" line for listings. */
	activity: string;
	inbox: AgentMessage[];
	/** "main" or the id of the agent that started this one. */
	parentId: string;
	/** 1 = started by the main chat. */
	depth: number;
	/** Chat session (URI string) of the root of this agent tree. */
	session?: string;
	/** The starter waits for the report synchronously (no notification). */
	awaited: boolean;
	/** Stopped by the user from the UI: report is kept, chat is not resumed. */
	stoppedByUser?: boolean;
	/** Current context size in tokens (provider usage, else an estimate). */
	contextTokens: number;
	/** The model's input window. */
	maxContextTokens: number;
	/** Whether `contextTokens` comes from real provider usage. */
	contextExact: boolean;
	/** How many times the history was auto-compacted. */
	compactions: number;
	/** How many times the agent was resumed after finishing. */
	resumes: number;
}

interface AgentRuntime {
	record: AgentRecord;
	model: vscode.LanguageModelChat;
	tools: vscode.LanguageModelChatTool[];
	cts: vscode.CancellationTokenSource;
	/** Main chat's invocation token; dropped once that request is over. */
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	/** Wakes an agent blocked in waitForAgents. */
	wake?: () => void;
	done: Promise<void>;
	/** Conversation of the agent — kept after it finishes so it can be resumed. */
	messages: vscode.LanguageModelChatMessage[];
	/** messages.length when the last exact usage was reported. */
	usageAtLength?: number;
	/** Exact token count at `usageAtLength`. */
	usageBase?: number;
	/** The user allowed every shell command of this agent. */
	allowAllCommands: { value: boolean };
}

export interface StartAgentOptions {
	name?: string;
	task: string;
	expectedOutput?: string;
	model: vscode.LanguageModelChat;
	allowWrite: boolean;
	maxSteps: number;
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	parentId?: string;
	session?: string;
	awaited?: boolean;
}

/** One model response of an agent. */
interface AgentTurn {
	text: string;
	calls: vscode.LanguageModelToolCallPart[];
	thinking: vscode.LanguageModelThinkingPart[];
}

/** Assistant message for the history: thinking first, then text, then tool calls. */
function assistantMessage(turn: AgentTurn, fallbackText?: string): vscode.LanguageModelChatMessage {
	const text = turn.text || fallbackText || "";
	return vscode.LanguageModelChatMessage.Assistant([
		...turn.thinking,
		...(text ? [new vscode.LanguageModelTextPart(text)] : []),
		...turn.calls,
	] as unknown as vscode.LanguageModelTextPart[]);
}

/** Input of the `delegateTask` tool (main chat and agents). */
export interface DelegateTaskInput {
	task: string;
	name?: string;
	background?: boolean;
	expectedOutput?: string;
	model?: string;
	allowWrite?: boolean;
	maxSteps?: number;
}

const SYSTEM_PROMPT = [
	"You are a subagent working for the main coding agent inside VS Code. Your agent id is {ID}, your name is \"{NAME}\". You were started by {PARENT}.",
	"You run in a fresh context: you only know what the task below tells you plus what you discover with tools.",
	"Work autonomously — never ask the user questions. Prefer targeted searches over reading whole files.",
	"Do not modify anything unless the task explicitly allows it and write tools are available.",
	"Other agents may run in parallel. `customcopilot_listAgents` shows them; `customcopilot_sendAgentMessage` sends a message to the main agent (to: \"main\"), to your parent, or to another agent (its id or name) — use it to coordinate, avoid duplicate work, or ask for a decision; `customcopilot_waitForAgents` waits for messages or for other agents to finish. Messages sent to you appear at the start of your next round.",
	"{SPAWN}",
	"Finish with a single final message that is the report for whoever started you: concise, factual, with exact file paths and line numbers where relevant. Do not include intermediate reasoning or tool logs in the report.",
].join("\n");

/** Sentinel marking the first message of a subagent conversation. */
const SUBAGENT_SENTINEL = "[customcopilot-subagent]";

function truncate(text: string, max: number, what: string): string {
	return text.length > max ? `${text.slice(0, max)}\n…[${what} truncated, ${text.length - max} more chars]` : text;
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
	return truncate(text, MAX_TOOL_RESULT_CHARS, "tool result");
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function setting<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`customcopilot.subagent.${key}`, fallback);
}

export function formatTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "ctx 45k/200k (22%)" — `~` when estimated. */
export function contextLabel(r: AgentRecord): string {
	const pct = r.maxContextTokens > 0 ? Math.round((r.contextTokens / r.maxContextTokens) * 100) : 0;
	return `ctx ${r.contextExact ? "" : "~"}${formatTokens(r.contextTokens)}/${formatTokens(r.maxContextTokens)} (${pct}%)`;
}

/** Rough token estimate of a conversation (≈ 3.5 chars per token). */
function estimateTokens(messages: readonly vscode.LanguageModelChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		for (const p of m.content) {
			if (p instanceof vscode.LanguageModelTextPart) {
				chars += p.value.length;
			} else if (p instanceof vscode.LanguageModelToolResultPart) {
				for (const c of p.content) {
					chars += c instanceof vscode.LanguageModelTextPart ? c.value.length : 0;
				}
			} else if (p instanceof vscode.LanguageModelToolCallPart) {
				chars += p.name.length + JSON.stringify(p.input ?? {}).length;
			}
		}
	}
	return Math.ceil(chars / 3.5);
}

/**
 * VS Code cancellation crossing the RPC boundary arrives as a plain Error
 * named "Canceled" (not a vscode.CancellationError instance).
 */
export function isCancellation(err: unknown): boolean {
	return err instanceof vscode.CancellationError || (err instanceof Error && err.name === "Canceled");
}

/** Context-window overflow errors (OpenAI/Anthropic/Gemini/GLM/Ollama wordings). */
function isContextOverflow(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /context[ _-]?(length|window|size)|maximum context|too many tokens|prompt is too long|input is too long|token limit|reduce the length|exceeds? the (maximum|limit)|\[413\]|\b1261\b|n_ctx/i.test(msg);
}

const COMPACT_PROMPT =
	"Your context window is nearly full. Write a compact but complete summary of your work so far that lets you continue without the earlier conversation: the task and constraints, every concrete finding (exact file paths, line numbers, symbols, values), what you already changed, open questions, and your remaining plan. Do not call tools. Output only the summary.";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class AgentManager {
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly notifications: AgentNotification[] = [];
	private nextId = 1;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	/** Fired on any agent status change, new message or notification. */
	readonly onDidChange = this.changeEmitter.event;
	/** Resolvers of main-agent waitForAgents calls. */
	private readonly mainWaiters = new Set<() => void>();
	private autoResumeTimer: NodeJS.Timeout | undefined;
	/** Last chat session our tools were invoked from (≈ the focused chat). */
	private lastActiveSession: string | undefined;

	/** Record the chat session a main-chat tool call came from. */
	noteActiveSession(session: string | undefined): void {
		if (session) {
			this.lastActiveSession = session;
		}
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/** Start an agent, or return an error string (limits). */
	start(opts: StartAgentOptions): AgentRecord | string {
		const maxConcurrent = Math.max(1, setting("maxConcurrent", 4));
		if (this.runningCount() >= maxConcurrent) {
			return `Error: ${maxConcurrent} agents are already running (customcopilot.subagent.maxConcurrent). Wait for one (customcopilot_waitForAgents) or stop one.`;
		}
		const parent = opts.parentId && opts.parentId !== MAIN_AGENT ? this.agents.get(opts.parentId)?.record : undefined;
		const depth = parent ? parent.depth + 1 : 1;
		const id = `a${this.nextId++}`;
		const record: AgentRecord = {
			id,
			name: (opts.name ?? "").trim() || id,
			task: opts.task,
			expectedOutput: opts.expectedOutput,
			modelId: opts.model.id,
			modelName: opts.model.name,
			status: "running",
			allowWrite: opts.allowWrite,
			maxSteps: opts.maxSteps,
			steps: 0,
			toolCalls: 0,
			startedAt: Date.now(),
			activity: "starting",
			inbox: [],
			parentId: parent ? parent.id : MAIN_AGENT,
			depth,
			session: parent ? parent.session : opts.session,
			awaited: opts.awaited === true,
			contextTokens: 0,
			maxContextTokens: opts.model.maxInputTokens,
			contextExact: false,
			compactions: 0,
			resumes: 0,
		};
		const runtime: AgentRuntime = {
			record,
			model: opts.model,
			tools: pickTools(opts.allowWrite, depth < Math.max(1, setting("maxDepth", 3))),
			cts: new vscode.CancellationTokenSource(),
			// Background agents run DETACHED from the chat request: its token
			// goes stale when the turn ends (and would attach tool UI to the
			// user's next turn). Foreground (awaited) agents run inside the live
			// request and use it.
			toolInvocationToken: opts.awaited ? opts.toolInvocationToken : undefined,
			done: Promise.resolve(),
			messages: [],
			allowAllCommands: { value: false },
		};
		this.agents.set(id, runtime);
		runtime.done = this.runLoop(runtime).catch((err) => {
			logger.error("subagent.crash", { id, error: err instanceof Error ? err.message : String(err) });
		});
		this.pruneFinished();
		this.changeEmitter.fire();
		logger.info("subagent.start", { id, parent: record.parentId, depth, model: opts.model.id, tools: runtime.tools.length });
		return record;
	}

	/**
	 * Shared implementation of `delegateTask` for the main chat and agents.
	 * Returns the tool-result text.
	 */
	async delegate(
		caller: string,
		input: DelegateTaskInput,
		callerModel: vscode.LanguageModelChat | undefined,
		ctx: { toolInvocationToken: vscode.ChatParticipantToolToken | undefined; session?: string; token: vscode.CancellationToken }
	): Promise<string> {
		const task = (input.task ?? "").trim();
		if (!task) {
			return "Error: `task` is required.";
		}
		const parentRecord = caller !== MAIN_AGENT ? this.agents.get(caller)?.record : undefined;
		if (caller !== MAIN_AGENT) {
			const maxDepth = Math.max(1, setting("maxDepth", 3));
			if (!parentRecord || parentRecord.depth >= maxDepth) {
				return `Error: nesting limit reached (customcopilot.subagent.maxDepth = ${maxDepth}). Do the work yourself.`;
			}
		}
		const defaultSteps = Math.max(1, setting("maxSteps", 15));
		const maxSteps = Math.min(HARD_MAX_STEPS, Math.max(1, Math.floor(input.maxSteps ?? defaultSteps)));
		// A read-only parent can never grant write tools to its children.
		const allowWrite = input.allowWrite === true && (parentRecord ? parentRecord.allowWrite : true);
		const model = await selectModel(input.model, callerModel);
		if (!model) {
			return "Error: no language model is available for the subagent.";
		}
		const background = input.background !== false;
		const started = this.start({
			name: input.name,
			task,
			expectedOutput: input.expectedOutput,
			model,
			allowWrite,
			maxSteps,
			toolInvocationToken: ctx.toolInvocationToken,
			parentId: caller,
			session: ctx.session,
			awaited: !background,
		});
		if (typeof started === "string") {
			return `${started}\n\n${this.describe(caller)}`;
		}
		if (!background) {
			const done = await this.waitFor(started.id, ctx.token);
			return `[Subagent ${started.id} "${started.name}" — ${model.name}, ${done?.status}, ${done?.steps} rounds, ${done?.toolCalls} tool calls]\n\n${done?.report ?? done?.error ?? ""}`;
		}
		const whereReport =
			caller === MAIN_AGENT
				? "customcopilot_waitForAgents returns it (use it when you have nothing else to do), and if this turn ends first it is posted to this chat"
				: "it arrives as a message at the start of one of your next rounds (customcopilot_waitForAgents waits for it)";
		return (
			`Started background agent ${started.id} "${started.name}" on ${model.name} [${model.id}] (${allowWrite ? "read/write" : "read-only"}, up to ${maxSteps} rounds). ` +
			`Keep working — do not wait idly. Its report is delivered automatically: ${whereReport}. ` +
			`Steer it with customcopilot_sendAgentMessage (to: "${started.id}").`
		);
	}

	/** Wait for one agent (foreground mode). Cancelling `token` stops the agent. */
	async waitFor(id: string, token: vscode.CancellationToken): Promise<AgentRecord | undefined> {
		const runtime = this.agents.get(id);
		if (!runtime) {
			return undefined;
		}
		const sub = token.onCancellationRequested(() => this.stop(id));
		try {
			await runtime.done;
		} finally {
			sub.dispose();
		}
		return runtime.record;
	}

	/**
	 * Resume a finished / stopped / failed agent with a new instruction: it
	 * continues from its full previous conversation (Claude Code style) and
	 * reports again when done. `caller` must be the main agent or an ancestor.
	 */
	async resume(
		caller: string,
		idOrName: string,
		message: string,
		ctx: {
			toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
			token: vscode.CancellationToken;
			background?: boolean;
			session?: string;
		}
	): Promise<string> {
		const runtime = this.find(idOrName);
		if (!runtime) {
			return `Error: no agent "${idOrName}".`;
		}
		const r = runtime.record;
		if (caller !== MAIN_AGENT && !this.isDescendant(r, caller)) {
			return "Error: you can only resume your own sub-agents.";
		}
		if (r.status === "running") {
			return `Agent ${r.id} is still running — send it a message instead (customcopilot_sendAgentMessage).`;
		}
		if (runtime.messages.length === 0) {
			return `Error: agent ${r.id} has no conversation to resume.`;
		}
		const maxConcurrent = Math.max(1, setting("maxConcurrent", 4));
		if (this.runningCount() >= maxConcurrent) {
			return `Error: ${maxConcurrent} agents are already running (customcopilot.subagent.maxConcurrent).`;
		}
		const text = (message ?? "").trim() || "Continue the task.";
		const budget = Math.max(1, setting("maxSteps", 15));
		r.status = "running";
		r.endedAt = undefined;
		r.error = undefined;
		r.stoppedByUser = undefined;
		r.resumes++;
		r.maxSteps = Math.min(r.steps + budget, r.steps + HARD_MAX_STEPS);
		r.awaited = ctx.background === false;
		r.activity = "resuming";
		if (caller === MAIN_AGENT && ctx.session) {
			r.session = ctx.session;
		}
		runtime.messages.push(
			vscode.LanguageModelChatMessage.User(
				`[Resumed by ${caller === MAIN_AGENT ? "the main agent" : `agent ${caller}`}] ${text}\n\n(Up to ${budget} more tool rounds. Finish with an updated report.)`
			)
		);
		runtime.cts = new vscode.CancellationTokenSource();
		runtime.toolInvocationToken = ctx.background === false ? ctx.toolInvocationToken : undefined;
		runtime.done = this.runLoop(runtime).catch((err) => {
			logger.error("subagent.crash", { id: r.id, error: err instanceof Error ? err.message : String(err) });
		});
		this.changeEmitter.fire();
		logger.info("subagent.resume", { id: r.id, by: caller });
		if (ctx.background === false) {
			const done = await this.waitFor(r.id, ctx.token);
			return `[Subagent ${r.id} "${r.name}" resumed — ${done?.status}, ${done?.steps} rounds total]\n\n${done?.report ?? done?.error ?? ""}`;
		}
		return `Resumed agent ${r.id} "${r.name}" in the background with its previous context (${formatTokens(r.contextTokens)} tokens). Its new report is delivered like before.`;
	}

	/** Stop an agent and its whole sub-tree. `byUser`: stopped from the UI. */
	stop(idOrName: string, byUser = false): AgentRecord | undefined {
		const runtime = this.find(idOrName);
		if (!runtime) {
			return undefined;
		}
		// Whole sub-tree, also below a child that already finished.
		for (const child of this.agents.values()) {
			if (child.record.parentId === runtime.record.id) {
				this.stop(child.record.id, byUser);
			}
		}
		if (runtime.record.status === "running") {
			runtime.record.stoppedByUser = runtime.record.stoppedByUser || byUser || undefined;
			runtime.cts.cancel();
			runtime.wake?.();
		}
		return runtime.record;
	}

	stopAll(byUser = false): void {
		for (const r of this.agents.values()) {
			if (r.record.status === "running") {
				r.record.stoppedByUser = r.record.stoppedByUser || byUser || undefined;
				r.cts.cancel();
				r.wake?.();
			}
		}
	}

	// ── Queries ────────────────────────────────────────────────────────

	find(idOrName: string): AgentRuntime | undefined {
		const key = (idOrName ?? "").trim();
		if (!key) {
			return undefined;
		}
		const byId = this.agents.get(key);
		if (byId) {
			return byId;
		}
		const lower = key.toLowerCase();
		// Prefer a running agent when names repeat.
		const matches = [...this.agents.values()].filter((r) => r.record.name.toLowerCase() === lower);
		return matches.find((r) => r.record.status === "running") ?? matches[matches.length - 1];
	}

	list(): AgentRecord[] {
		return [...this.agents.values()].map((r) => r.record);
	}

	/** Agents ordered as a tree (parent before its children). */
	tree(): AgentRecord[] {
		const all = this.list();
		const out: AgentRecord[] = [];
		const visit = (parentId: string) => {
			for (const a of all.filter((x) => x.parentId === parentId)) {
				out.push(a);
				visit(a.id);
			}
		};
		visit(MAIN_AGENT);
		// Orphans (parent pruned) at the end.
		for (const a of all) {
			if (!out.includes(a)) {
				out.push(a);
			}
		}
		return out;
	}

	runningCount(): number {
		return this.list().filter((r) => r.status === "running").length;
	}

	/** Notifications visible from `session` (its own + unscoped); all when undefined. */
	private visible(n: AgentNotification, session: string | undefined): boolean {
		return session === undefined || !n.session || n.session === session;
	}

	unreadNotifications(session?: string): number {
		return this.notifications.filter((n) => this.visible(n, session)).length;
	}

	/** Take (and mark read) the main agent's notifications for `session` (all when undefined). */
	drainNotifications(session?: string): AgentNotification[] {
		const taken = this.notifications.filter((n) => this.visible(n, session));
		const kept = this.notifications.filter((n) => !this.visible(n, session));
		this.notifications.splice(0, this.notifications.length, ...kept);
		if (taken.length) {
			this.changeEmitter.fire();
		}
		return taken;
	}

	/** Human/LLM-readable listing. */
	describe(viewer: string): string {
		const agents = this.tree();
		if (agents.length === 0) {
			return "No background agents.";
		}
		const lines = agents.map((a) => {
			const age = formatDuration((a.endedAt ?? Date.now()) - a.startedAt);
			const me = a.id === viewer ? " (you)" : "";
			const status = a.status === "running" ? `running — ${a.activity}` : a.status;
			const indent = "  ".repeat(a.depth - 1);
			return `${indent}- ${a.id} "${a.name}"${me} [${status}] parent=${a.parentId}, model=${a.modelName} [${a.modelId}], ${contextLabel(a)}, ${a.steps}/${a.maxSteps} rounds, ${a.toolCalls} tool calls, ${age}${a.inbox.length ? `, ${a.inbox.length} unread msg` : ""}\n${indent}  task: ${a.task.length > 160 ? `${a.task.slice(0, 157)}…` : a.task}`;
		});
		const unread =
			viewer === MAIN_AGENT && this.notifications.length
				? `\n\n${this.notifications.length} unread notification(s) for main — call customcopilot_waitForAgents to read them.`
				: "";
		return `${lines.join("\n")}${unread}`;
	}

	/** Full details incl. report for one agent. */
	details(idOrName: string): string | undefined {
		const r = this.find(idOrName)?.record;
		if (!r) {
			return undefined;
		}
		return [
			`${r.id} "${r.name}" [${r.status}] parent=${r.parentId}, model=${r.modelName} [${r.modelId}], ${r.steps} rounds, ${r.toolCalls} tool calls`,
			`Context: ${contextLabel(r)}${r.compactions ? `, auto-compacted ${r.compactions}×` : ""}${r.resumes ? `, resumed ${r.resumes}×` : ""}`,
			`Sub-agents: ${this.list().filter((a) => a.parentId === r.id).map((a) => `${a.id} "${a.name}" [${a.status}]`).join(", ") || "none"}`,
			`Task: ${r.task}`,
			r.status === "running" ? `Currently: ${r.activity}` : "",
			r.error ? `Error: ${r.error}` : "",
			r.report ? `Report:\n${r.report}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}

	// ── Messaging ──────────────────────────────────────────────────────

	/**
	 * Deliver a message. `to` = "main", an agent id/name, or "all" (every
	 * running agent except the sender). Returns a status line.
	 */
	send(from: string, to: string, text: string): string {
		const target = (to ?? "").trim();
		const body = (text ?? "").trim();
		if (!body) {
			return "Error: empty message.";
		}
		const fromRecord = this.agents.get(from)?.record;
		const fromName = from === MAIN_AGENT ? MAIN_AGENT : fromRecord?.name ?? from;
		const sender = from === MAIN_AGENT ? MAIN_AGENT : `${from} "${fromName}"`;
		if (target.toLowerCase() === MAIN_AGENT) {
			if (from === MAIN_AGENT) {
				return "Error: cannot message yourself.";
			}
			this.notify({ kind: "message", agentId: from, agentName: fromName, text: body, at: Date.now(), session: fromRecord?.session });
			return "Message delivered to the main agent.";
		}
		const recipients =
			target.toLowerCase() === "all"
				? [...this.agents.values()].filter((r) => r.record.status === "running" && r.record.id !== from)
				: [this.find(target)].filter((r): r is AgentRuntime => !!r);
		if (recipients.length === 0) {
			return `Error: no agent "${target}". Known: ${this.list().map((a) => `${a.id} "${a.name}"`).join(", ") || "none"}.`;
		}
		const delivered: string[] = [];
		const skipped: string[] = [];
		for (const r of recipients) {
			if (r.record.id === from) {
				continue;
			}
			if (r.record.status !== "running") {
				skipped.push(`${r.record.id} (${r.record.status})`);
				continue;
			}
			this.deliver(r, sender, body);
			delivered.push(r.record.id);
		}
		return [
			delivered.length ? `Delivered to ${delivered.join(", ")} (read at their next round).` : "",
			skipped.length ? `Not delivered — already finished: ${skipped.join(", ")}.` : "",
		]
			.filter(Boolean)
			.join(" ");
	}

	private deliver(r: AgentRuntime, from: string, text: string): void {
		r.record.inbox.push({ from, text, at: Date.now() });
		r.wake?.();
		this.changeEmitter.fire();
	}

	// ── Waiting ────────────────────────────────────────────────────────

	/**
	 * Main agent: wait until a notification is available (an agent finished or
	 * sent a message), `ids` all finished, the timeout passes or `token` fires.
	 */
	async waitMain(
		ids: string[] | undefined,
		timeoutMs: number,
		token: vscode.CancellationToken,
		session?: string
	): Promise<void> {
		const mine = () => this.notifications.filter((n) => this.visible(n, session));
		const ready = () => {
			if (ids && ids.length > 0) {
				const targets = ids.map((i) => this.find(i)).filter((r): r is AgentRuntime => !!r);
				return (
					targets.length === 0 ||
					targets.every((r) => r.record.status !== "running") ||
					mine().some((n) => n.kind === "message")
				);
			}
			return mine().length > 0 || this.runningCount() === 0;
		};
		if (ready() || timeoutMs <= 0) {
			return;
		}
		await new Promise<void>((resolve) => {
			const check = () => {
				if (ready() || token.isCancellationRequested) {
					finish();
				}
			};
			const finish = () => {
				this.mainWaiters.delete(check);
				clearTimeout(timer);
				sub.dispose();
				changeSub.dispose();
				resolve();
			};
			const sub = token.onCancellationRequested(finish);
			const changeSub = this.onDidChange(check);
			const timer = setTimeout(finish, timeoutMs);
			this.mainWaiters.add(check);
		});
	}

	/** A subagent waits for an inbox message or for `ids` to finish. */
	private async waitAgent(runtime: AgentRuntime, ids: string[] | undefined, timeoutMs: number): Promise<void> {
		const ready = () => {
			if (runtime.record.inbox.length > 0 || runtime.cts.token.isCancellationRequested) {
				return true;
			}
			if (ids && ids.length > 0) {
				return ids
					.map((i) => this.find(i))
					.filter((r): r is AgentRuntime => !!r && r !== runtime)
					.every((r) => r.record.status !== "running");
			}
			return false;
		};
		if (ready() || timeoutMs <= 0) {
			return;
		}
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				sub.dispose();
				runtime.wake = undefined;
				resolve();
			};
			const timer = setTimeout(finish, timeoutMs);
			const sub = this.onDidChange(() => {
				if (ready()) {
					finish();
				}
			});
			runtime.wake = () => {
				if (ready()) {
					finish();
				}
			};
		});
	}

	// ── Reporting / auto-resume ────────────────────────────────────────

	/**
	 * Route a finished agent's report to its parent: the nearest RUNNING
	 * ancestor agent's inbox, else the main agent.
	 */
	private report(r: AgentRecord, text: string): void {
		if (r.awaited) {
			// The starter receives it as the delegate tool result.
			this.changeEmitter.fire();
			return;
		}
		let parentId = r.parentId;
		while (parentId !== MAIN_AGENT) {
			const parent = this.agents.get(parentId);
			if (parent && parent.record.status === "running") {
				this.deliver(parent, `sub-agent ${r.id} "${r.name}" (${r.status}) — its final report`, text);
				return;
			}
			parentId = parent?.record.parentId ?? MAIN_AGENT;
		}
		this.notify({
			kind: "finished",
			agentId: r.id,
			agentName: r.name,
			text,
			at: Date.now(),
			session: r.session,
			quiet: r.stoppedByUser === true,
		});
	}

	private notify(n: AgentNotification): void {
		this.notifications.push(n);
		this.changeEmitter.fire();
		if (this.mainWaiters.size > 0) {
			// A main agent is blocked in waitForAgents — it wakes up and
			// receives the notification as its tool result.
			for (const check of [...this.mainWaiters]) {
				check();
			}
			return;
		}
		if (!n.quiet) {
			this.scheduleAutoResume();
		}
	}

	private scheduleAutoResume(): void {
		if (!setting("autoResume", true) || this.autoResumeTimer) {
			return;
		}
		const idleMs = Math.max(1000, setting("autoResumeIdleMs", 5000));
		const tick = () => {
			this.autoResumeTimer = undefined;
			if (!this.notifications.some((n) => !n.quiet)) {
				return;
			}
			if (this.mainWaiters.size > 0) {
				// A waiter may consume them; if it is cancelled instead, they
				// must still be posted — check again later.
				this.autoResumeTimer = setTimeout(tick, idleMs);
				return;
			}
			if (!isMainChatIdle(idleMs)) {
				// Main turn still running: it gets an injected notice on its
				// next model request; check again later in case it ends.
				this.autoResumeTimer = setTimeout(tick, idleMs);
				return;
			}
			void this.autoResume();
		};
		this.autoResumeTimer = setTimeout(tick, idleMs);
	}

	/** Post pending notifications to their chat sessions as new messages. */
	private async autoResume(): Promise<void> {
		// Only sessions with at least one non-quiet notification are resumed;
		// quiet ones (user-stopped agents) stay unread otherwise.
		const sessions = new Set(this.notifications.filter((n) => !n.quiet).map((n) => n.session ?? ""));
		const bySession = new Map<string, AgentNotification[]>();
		for (const key of sessions) {
			const items = this.notifications.filter((n) => (n.session ?? "") === key);
			bySession.set(key, items);
		}
		this.notifications.splice(
			0,
			this.notifications.length,
			...this.notifications.filter((n) => !sessions.has(n.session ?? ""))
		);
		this.changeEmitter.fire();
		for (const [session, items] of bySession) {
			const query = formatNotifications(items, AUTO_RESUME_REPORT_CHARS, true);
			try {
				await this.postToSession(session || undefined, query);
				logger.info("subagent.autoResume", { notifications: items.length, session: session || "focused" });
			} catch (err) {
				// Could not reach the chat: keep them for waitForAgents / the notice.
				this.notifications.unshift(...items);
				logger.warn("subagent.autoResume.failed", { error: err instanceof Error ? err.message : String(err) });
			}
		}
	}

	/**
	 * Submit `query` to a specific chat session. `workbench.action.chat.open`
	 * submits to the last focused chat: when the session is not the one our
	 * tools were last called from, it is revealed first (`vscode.open` on its
	 * chat URI). `preserveInput` keeps the user's draft in the input box.
	 */
	private async postToSession(session: string | undefined, query: string): Promise<void> {
		if (session && session !== this.lastActiveSession) {
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(session));
			await sleep(500);
			this.lastActiveSession = session;
		}
		await vscode.commands.executeCommand("workbench.action.chat.open", { query, isPartialQuery: false, preserveInput: true });
	}

	// ── Agent loop ─────────────────────────────────────────────────────

	private async runLoop(runtime: AgentRuntime): Promise<void> {
		const r = runtime.record;
		const token = runtime.cts.token;
		const canSpawn = runtime.tools.some((t) => t.name === AGENT_TOOL_NAMES.run);
		const userPrompt = [
			`${SUBAGENT_SENTINEL}\n${SYSTEM_PROMPT.replace("{ID}", r.id)
				.replace("{NAME}", r.name)
				.replace("{PARENT}", r.parentId === MAIN_AGENT ? "the main agent" : `agent ${r.parentId}`)
				.replace(
					"{SPAWN}",
					canSpawn
						? "You may start your own sub-agents with `customcopilot_delegateTask` for independent parts of your task (they run on your model; their reports arrive in your inbox) and stop them with `customcopilot_stopAgent`."
						: "You cannot start further sub-agents (nesting limit)."
				)}`,
			`# Task\n${r.task}`,
			r.expectedOutput ? `# Expected report\n${r.expectedOutput}` : "",
			`# Limits\nAt most ${r.maxSteps} tool rounds. ${r.allowWrite ? "Write tools are available." : "Read-only: you cannot modify files."}`,
		]
			.filter(Boolean)
			.join("\n\n");
		// A resumed agent continues its kept conversation.
		if (runtime.messages.length === 0) {
			runtime.messages.push(vscode.LanguageModelChatMessage.User(userPrompt));
		}
		const messages = runtime.messages;
		let finalText = "";
		/** Rounds the model kept calling tools after the budget was exhausted. */
		let overrun = 0;
		try {
			for (;;) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const lastRound = r.steps >= r.maxSteps;
				// Auto-compact before the window overflows.
				this.updateContext(runtime);
				const threshold = Math.min(0.95, Math.max(0.3, setting("compactThreshold", 0.8)));
				// (Not when there is nothing left to compress: task + summary only.)
				if (r.maxContextTokens > 0 && r.contextTokens >= r.maxContextTokens * threshold && messages.length > 3) {
					await this.compact(runtime);
				}
				r.activity = `thinking (round ${r.steps + 1})`;
				this.changeEmitter.fire();
				// Tools are always declared (Anthropic rejects tool_use history
				// without a tools list); on the last round the model is told to
				// stop calling them.
				let turn: AgentTurn;
				try {
					turn = await this.request(runtime, runtime.tools);
				} catch (err) {
					// Window overflowed anyway (estimate was off): compact, retry once.
					if (!isContextOverflow(err) || token.isCancellationRequested || messages.length <= 2) {
						throw err;
					}
					await this.compact(runtime);
					turn = await this.request(runtime, runtime.tools);
				}
				const { text, calls } = turn;
				// Stopped while the model was answering: never report it as done.
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				if (calls.length === 0) {
					// Messages (incl. sub-agent reports) that arrived while it was
					// writing the report: let it react before finishing.
					if (r.inbox.length > 0 && !lastRound) {
						messages.push(assistantMessage(turn, "(draft)"));
						messages.push(vscode.LanguageModelChatMessage.User(this.drainInbox(runtime)));
						r.steps++;
						continue;
					}
					// Its own sub-agents are still running: wait for their
					// reports instead of finishing without them.
					if (!lastRound && this.runningChildren(r.id) > 0) {
						messages.push(assistantMessage(turn, "(draft)"));
						r.activity = "waiting for sub-agents";
						this.changeEmitter.fire();
						await this.waitAgent(
							runtime,
							this.list()
								.filter((a) => a.parentId === r.id)
								.map((a) => a.id),
							30 * 60_000
						);
						messages.push(
							vscode.LanguageModelChatMessage.User(
								r.inbox.length
									? this.drainInbox(runtime)
									: this.runningChildren(r.id) > 0
										? "Your sub-agents are still running (the wait timed out). Write your report with what you have, or keep waiting with customcopilot_waitForAgents."
										: "Your sub-agents finished. Write your final report now."
							)
						);
						r.steps++;
						continue;
					}
					finalText = text;
					// Kept in the history so a resume continues after the report.
					messages.push(assistantMessage(turn, "(empty report)"));
					break;
				}
				r.steps++;
				messages.push(assistantMessage(turn));
				const results: Array<vscode.LanguageModelToolResultPart | vscode.LanguageModelTextPart> = [];
				if (lastRound) {
					// Budget exhausted: answer the calls without running them.
					overrun++;
					for (const call of calls) {
						results.push(
							new vscode.LanguageModelToolResultPart(call.callId, [
								new vscode.LanguageModelTextPart("Not executed: the step budget is exhausted. Write your final report now."),
							])
						);
					}
					messages.push(vscode.LanguageModelChatMessage.User(results));
					if (overrun >= 2) {
						finalText = text || "(no report — the step budget was exhausted while the agent kept calling tools)";
						break;
					}
					continue;
				}
				for (let i = 0; i < calls.length; i++) {
					const call = calls[i];
					r.toolCalls++;
					r.activity = `running ${call.name}`;
					this.changeEmitter.fire();
					let resultText: string;
					try {
						resultText = await this.invokeAgentTool(runtime, call);
					} catch (err) {
						// Stopped mid-tool: answer every pending call so the kept
						// history stays a valid conversation for a later resume.
						for (const c of calls.slice(i)) {
							results.push(
								new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart("(cancelled — the agent was stopped)")])
							);
						}
						messages.push(vscode.LanguageModelChatMessage.User(results));
						throw err;
					}
					results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(resultText)]));
				}
				if (r.inbox.length > 0) {
					results.push(new vscode.LanguageModelTextPart(this.drainInbox(runtime)));
				}
				if (r.steps >= r.maxSteps) {
					results.push(new vscode.LanguageModelTextPart("Step budget reached. Write your final report now, without calling tools."));
				}
				messages.push(vscode.LanguageModelChatMessage.User(results));
			}
			r.report = truncate(finalText.trim() || "(the agent returned an empty report)", MAX_REPORT_CHARS, "report");
			r.status = "done";
		} catch (err) {
			if (isCancellation(err) || token.isCancellationRequested) {
				r.status = "stopped";
				r.error = r.stoppedByUser ? "stopped by the user" : "stopped before finishing";
			} else {
				r.status = "failed";
				r.error = err instanceof Error ? err.message : String(err);
			}
		} finally {
			r.endedAt = Date.now();
			r.activity = r.status;
			runtime.cts.dispose();
			logger.info("subagent.end", { id: r.id, status: r.status, steps: r.steps, toolCalls: r.toolCalls, ms: r.endedAt - r.startedAt });
			// Messages / sub-agent reports that arrived after it could react
			// travel up with its report instead of dying in its inbox.
			const leftovers = r.inbox.splice(0, r.inbox.length);
			const tail = leftovers.length
				? `\n\n[Unread when it finished]\n${leftovers.map((m) => `From ${m.from}: ${m.text}`).join("\n\n")}`
				: "";
			this.report(
				r,
				(r.status === "done" ? r.report ?? "" : `${r.status.toUpperCase()}: ${r.error ?? ""}${r.report ? `\n${r.report}` : ""}`) + tail
			);
		}
	}

	/** One model round; tracks the real context size from the provider's usage part. */
	private async request(
		runtime: AgentRuntime,
		tools: vscode.LanguageModelChatTool[] | undefined,
		messages: vscode.LanguageModelChatMessage[] = runtime.messages
	): Promise<AgentTurn> {
		const r = runtime.record;
		const options: vscode.LanguageModelChatRequestOptions = {
			justification: "Background subagent started by the main chat",
			tools: tools && tools.length ? tools : undefined,
		};
		let response: vscode.LanguageModelChatResponse;
		try {
			response = await runtime.model.sendRequest(messages, options, runtime.cts.token);
		} catch (err) {
			// The model list was refreshed (e.g. configs re-indexed) and the
			// stored model object is gone: look it up again by its exact id.
			if (!/notfound|not found/i.test(`${(err as { code?: string }).code ?? ""} ${err instanceof Error ? err.message : ""}`)) {
				throw err;
			}
			const [again] = await vscode.lm.selectChatModels({ id: runtime.model.id });
			if (!again) {
				throw new Error(`The agent's model ${runtime.model.id} is no longer available (the model list changed).`);
			}
			runtime.model = again;
			response = await runtime.model.sendRequest(messages, options, runtime.cts.token);
		}
		let text = "";
		const calls: vscode.LanguageModelToolCallPart[] = [];
		const thinking: vscode.LanguageModelThinkingPart[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				calls.push(part);
			} else if (part instanceof vscode.LanguageModelThinkingPart) {
				// Kept for the replayed assistant turn: signed thinking (Anthropic
				// signature / redacted data, Responses encrypted reasoning) must
				// be sent back on tool-use turns.
				thinking.push(part);
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
				// Our provider reports exact token usage (prompt + completion =
				// what the next request will carry, before new tool results).
				try {
					const usage = JSON.parse(new TextDecoder().decode(part.data)) as { prompt_tokens?: number; completion_tokens?: number };
					const total = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
					if (total > 0) {
						r.contextTokens = total;
						r.contextExact = true;
						runtime.usageBase = total;
						runtime.usageAtLength = runtime.messages.length;
					}
				} catch {
					// ignore malformed usage
				}
			}
		}
		return { text, calls, thinking };
	}

	/**
	 * Context size: the last exact usage plus an estimate of what was added
	 * since (tool results), else a pure estimate.
	 */
	private updateContext(runtime: AgentRuntime): void {
		const r = runtime.record;
		if (runtime.usageAtLength !== undefined && runtime.usageBase !== undefined && runtime.usageAtLength <= runtime.messages.length) {
			// +1: the assistant turn of that response is already in completion_tokens.
			r.contextTokens = runtime.usageBase + estimateTokens(runtime.messages.slice(runtime.usageAtLength + 1));
			r.contextExact = true;
		} else {
			r.contextTokens = estimateTokens(runtime.messages);
			r.contextExact = false;
		}
	}

	/**
	 * Auto-compact (Claude Code style): the same model summarizes the work so
	 * far; the history is replaced by the original task + that summary.
	 */
	private async compact(runtime: AgentRuntime): Promise<void> {
		const r = runtime.record;
		const messages = runtime.messages;
		r.activity = "compacting context";
		this.changeEmitter.fire();
		const before = r.contextTokens;
		// Summarize from a trimmed copy: drop the oldest middle turns until the
		// request itself fits (keeps the task prompt and the latest turns).
		const work = [...messages];
		const cap = r.maxContextTokens > 0 ? r.maxContextTokens * 0.85 : Infinity;
		const isToolResultMsg = (m: vscode.LanguageModelChatMessage) =>
			m.content.some((p) => p instanceof vscode.LanguageModelToolResultPart);
		while (work.length > 3 && estimateTokens(work) > cap) {
			work.splice(1, 1);
			// Never leave a tool result without its assistant tool-call turn.
			while (work.length > 2 && isToolResultMsg(work[1])) {
				work.splice(1, 1);
			}
		}
		const trimmed = [...work];
		work.push(vscode.LanguageModelChatMessage.User(COMPACT_PROMPT));
		let summary = "";
		try {
			// Tools are declared (tool_use history needs them) — the prompt
			// forbids calling them; any call is ignored.
			const turn = await this.request(runtime, runtime.tools, work);
			summary = turn.text;
		} catch (err) {
			if (runtime.cts.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			logger.warn("subagent.compact.failed", { id: r.id, error: err instanceof Error ? err.message : String(err) });
		}
		if (!summary.trim()) {
			// No summary: keep the trimmed history (task + latest turns)
			// instead of throwing all the work away.
			messages.splice(0, messages.length, ...trimmed);
		} else {
			const taskPrompt = messages[0];
			messages.splice(
				0,
				messages.length,
				taskPrompt,
				vscode.LanguageModelChatMessage.User(
					`[Context auto-compacted — summary of your earlier work]\n${summary.trim()}\n\nContinue the task from here.${r.inbox.length ? `\n\n${this.drainInbox(runtime)}` : ""}`
				)
			);
		}
		r.compactions++;
		runtime.usageAtLength = undefined;
		runtime.usageBase = undefined;
		r.contextTokens = estimateTokens(messages);
		r.contextExact = false;
		logger.info("subagent.compact", { id: r.id, before, after: r.contextTokens });
		this.changeEmitter.fire();
	}

	private runningChildren(id: string): number {
		return this.list().filter((a) => a.parentId === id && a.status === "running").length;
	}

	private drainInbox(runtime: AgentRuntime): string {
		const msgs = runtime.record.inbox.splice(0, runtime.record.inbox.length);
		this.changeEmitter.fire();
		return `[Messages received]\n${msgs.map((m) => `From ${m.from}: ${m.text}`).join("\n\n")}`;
	}

	/** Agent tools are handled in-process (caller identity); others via vscode.lm. */
	private async invokeAgentTool(runtime: AgentRuntime, call: vscode.LanguageModelToolCallPart): Promise<string> {
		const input = (call.input ?? {}) as Record<string, unknown>;
		const id = runtime.record.id;
		switch (call.name) {
			case AGENT_TOOL_NAMES.list:
				return typeof input.id === "string" && input.id ? this.details(input.id) ?? `No agent "${input.id}".` : this.describe(id);
			case AGENT_TOOL_NAMES.send:
				return this.send(id, String(input.to ?? MAIN_AGENT), String(input.message ?? ""));
			case AGENT_TOOL_NAMES.wait: {
				const ids = Array.isArray(input.ids) ? input.ids.map(String) : undefined;
				const timeoutMs = Math.min(3600, Math.max(0, Number(input.timeoutSeconds ?? 300))) * 1000;
				runtime.record.activity = "waiting for messages";
				this.changeEmitter.fire();
				await this.waitAgent(runtime, ids, timeoutMs);
				const inbox = runtime.record.inbox.length ? `\n\n${this.drainInbox(runtime)}` : "\n\nNo new messages.";
				return `${this.describe(id)}${inbox}`;
			}
			case AGENT_TOOL_NAMES.run:
				return this.delegate(id, input as unknown as DelegateTaskInput, runtime.model, {
					toolInvocationToken: runtime.toolInvocationToken,
					token: runtime.cts.token,
				});
			case AGENT_TOOL_NAMES.resume:
				return this.resume(id, String(input.id ?? ""), String(input.message ?? ""), {
					toolInvocationToken: runtime.toolInvocationToken,
					token: runtime.cts.token,
					background: input.background !== false,
				});
			case AGENT_TOOL_NAMES.editFile:
			case AGENT_TOOL_NAMES.createFile:
			case AGENT_TOOL_NAMES.runCommand:
				return this.invokeWriteTool(runtime, call);
			case AGENT_TOOL_NAMES.stop: {
				// Agents may stop only their own descendants.
				const target = this.find(String(input.id ?? ""));
				if (!target || !this.isDescendant(target.record, id)) {
					return "Error: you can only stop your own sub-agents.";
				}
				this.stop(target.record.id);
				return `Stopping agent ${target.record.id} "${target.record.name}".`;
			}
		}
		try {
			const result = await this.invokeWithFallback(runtime, call);
			return toolResultToText(result) || "(empty result)";
		} catch (err) {
			if (runtime.cts.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	/** Write tools of write-enabled agents (see agentWriteTools.ts). */
	private async invokeWriteTool(runtime: AgentRuntime, call: vscode.LanguageModelToolCallPart): Promise<string> {
		const input = (call.input ?? {}) as Record<string, unknown>;
		if (!runtime.record.allowWrite) {
			return "Error: this agent is read-only.";
		}
		try {
			switch (call.name) {
				case AGENT_TOOL_NAMES.editFile:
					return await agentEditFile(input);
				case AGENT_TOOL_NAMES.createFile:
					return await agentCreateFile(input);
				default:
					return await agentRunCommand(input, `${runtime.record.id} "${runtime.record.name}"`, runtime.allowAllCommands, runtime.cts.token);
			}
		} catch (err) {
			return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	private isDescendant(r: AgentRecord, ancestorId: string): boolean {
		let parentId = r.parentId;
		while (parentId !== MAIN_AGENT) {
			if (parentId === ancestorId) {
				return true;
			}
			parentId = this.agents.get(parentId)?.record.parentId ?? MAIN_AGENT;
		}
		return false;
	}

	/**
	 * Invoke a workspace tool. Foreground agents use the live chat request's
	 * invocation token (tool UI/confirmations appear in the chat); background
	 * agents run detached (confirmations come as a modal dialog). If the token
	 * turns out stale (the request ended, or the session is gone), VS Code
	 * rejects the call — it is reported to the agent (not silently re-run,
	 * since the same error also means the user DENIED the call) and later calls
	 * run detached.
	 */
	private async invokeWithFallback(
		runtime: AgentRuntime,
		call: vscode.LanguageModelToolCallPart
	): Promise<vscode.LanguageModelToolResult> {
		const token = runtime.cts.token;
		try {
			return await vscode.lm.invokeTool(
				call.name,
				{ input: call.input, toolInvocationToken: runtime.toolInvocationToken },
				token
			);
		} catch (err) {
			if (token.isCancellationRequested) {
				throw err;
			}
			const stale = err instanceof Error && /Tool called for unknown chat (session|request)/i.test(err.message);
			if (runtime.toolInvocationToken && (isCancellation(err) || stale)) {
				runtime.toolInvocationToken = undefined;
				logger.info("subagent.detached", { id: runtime.record.id });
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(
						"Tool call was cancelled or denied (or the chat request ended). Later tool calls run detached — retry only if it is still needed."
					),
				]);
			}
			if (isCancellation(err)) {
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("Tool call was cancelled or denied by the user.")]);
			}
			throw err;
		}
	}

	/**
	 * Keep at most MAX_FINISHED_AGENTS finished agents, dropping the ones
	 * that finished first — never an ancestor of a still-running agent
	 * (ancestry is needed for routing reports and stop/resume rights).
	 */
	private pruneFinished(): void {
		const neededAncestors = new Set<string>();
		for (const r of this.agents.values()) {
			if (r.record.status === "running") {
				let p = r.record.parentId;
				while (p !== MAIN_AGENT) {
					neededAncestors.add(p);
					p = this.agents.get(p)?.record.parentId ?? MAIN_AGENT;
				}
			}
		}
		const finished = [...this.agents.values()]
			.filter((r) => r.record.status !== "running" && !neededAncestors.has(r.record.id))
			.sort((a, b) => (a.record.endedAt ?? 0) - (b.record.endedAt ?? 0));
		for (const r of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_AGENTS))) {
			this.agents.delete(r.record.id);
		}
	}

	dispose(): void {
		this.stopAll();
		if (this.autoResumeTimer) {
			clearTimeout(this.autoResumeTimer);
		}
		this.changeEmitter.dispose();
	}
}

/** Render notifications for the main agent (tool result or auto-resume message). */
export function formatNotifications(items: AgentNotification[], maxReportChars: number, forChat: boolean): string {
	const blocks = items.map((n) =>
		n.kind === "finished"
			? `### Agent ${n.agentId} "${n.agentName}" finished\n${truncate(n.text, maxReportChars, "report — call customcopilot_listAgents with this id for the full text")}`
			: `### Message from agent ${n.agentId} "${n.agentName}"\n${n.text}`
	);
	const header = forChat
		? `🤖 Background agent update (${items.length}). Continue the task using the results below; reply to agents with #agentMessage if needed.`
		: `${items.length} notification(s):`;
	return `${header}\n\n${blocks.join("\n\n")}`;
}

/** The singleton manager. */
export const agentManager = new AgentManager();

/**
 * Main-chat requests to OUR models carry a short notice while notifications
 * are unread, so a main agent that is still working learns about finished
 * agents without polling. The notice is not part of the persisted history;
 * it repeats until the main agent reads the notifications.
 */
export function withAgentNotice(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): readonly vscode.LanguageModelChatRequestMessage[] {
	const unread = agentManager.unreadNotifications();
	if (unread === 0) {
		return messages;
	}
	const first = messages.find((m) => m.role === vscode.LanguageModelChatMessageRole.User);
	const firstText = first?.content.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart | undefined;
	if (firstText?.value.startsWith(SUBAGENT_SENTINEL)) {
		return messages;
	}
	const running = agentManager.runningCount();
	const noticeText = `[System notice] ${unread} background agent notification(s) are waiting (agent reports / messages)${running ? `; ${running} agent(s) still running` : ""}. Call customcopilot_waitForAgents with timeoutSeconds 0 to read them now.`;
	const last = messages[messages.length - 1];
	if (last && last.role === vscode.LanguageModelChatMessageRole.User) {
		// Appended to the last user turn (after any tool results) — a separate
		// trailing message would break role alternation checks and the
		// "answers tool results" detection.
		const merged = new vscode.LanguageModelChatMessage2(
			last.role,
			[...last.content, new vscode.LanguageModelTextPart(`\n\n${noticeText}`)] as vscode.LanguageModelChatMessage2["content"],
			last.name
		) as unknown as vscode.LanguageModelChatRequestMessage;
		return [...messages.slice(0, -1), merged];
	}
	return [...messages, vscode.LanguageModelChatMessage.User(noticeText) as unknown as vscode.LanguageModelChatRequestMessage];
}
