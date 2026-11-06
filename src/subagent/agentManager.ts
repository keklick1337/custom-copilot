import * as vscode from "vscode";
import * as pathModule from "path";
import { logger } from "../logger";
import { autoResumeDepth, currentMainTurn, isAutopilotTurn, isMainChatIdle, noteMainCancelled, wasMainTurnCancelled } from "../chatActivity";
import { AGENT_TOOL_NAMES, AUTO_RESUME_HEADER } from "./agentNames";
import { HARD_MAX_STEPS, REPEAT_STOP, REPEAT_WARN, pickTools, selectModel } from "./agentSetup";
import { agentCreateFile, agentEditFile, agentRunCommand, disposeAgentTerminal } from "./agentWriteTools";
import { type AgentTypeDef, BUILT_IN_TYPES, describeAgentTypes, resolveAgentType } from "./agentTypes";
import {
	type AgentWorktree,
	applyWorktreeToMain,
	createAgentWorktree,
	currentBranch,
	describeChanges,
	removeAgentWorktree,
	setWorktreeLock,
	toWorktreePath,
	worktreeChanges,
} from "./agentWorktree";
import { SUBAGENT_SENTINEL, subagentFirstMessage, subagentSystemPrompt } from "./agentPrompts";

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

/** One entry of an agent's work log (shown in the agent map). */
export interface TranscriptEntry {
	kind: "task" | "thinking" | "text" | "tool" | "result" | "inbox" | "compact" | "report" | "error" | "resume";
	text: string;
	/** Tool name for "tool" / "result". */
	tool?: string;
	at: number;
}

/** Main chat (root of an agent tree) as known from tool calls / requests. */
export interface SessionInfo {
	session: string;
	title: string;
	modelName?: string;
	contextTokens?: number;
}

const MAX_TRANSCRIPT_ENTRIES = 600;
const MAX_TRANSCRIPT_TEXT = 6000;

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
	/** How many main-chat requests already carried a notice about it. */
	noticed?: number;
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
	/** A round limit was set explicitly (else `maxSteps` is only the safety cap). */
	stepLimit: boolean;
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
	/**
	 * Started during a turn that an auto-resume message triggered: its report
	 * never auto-resumes the chat again (prevents agent → report → agent loops).
	 */
	noAutoResume?: boolean;
	/** Shell commands run without asking (Autopilot / global auto-approve / setting). */
	autoApprove?: boolean;
	/** Tokens processed across all model requests (prompt + completion). */
	totalTokens: number;
	/** Readable log of the agent's work (for the agent map). */
	transcript: TranscriptEntry[];
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
	/** Agent type (`subagentType`): general-purpose, Explore, Plan or a custom agent. */
	agentType: string;
	/** Isolated git worktree it works in (own or inherited from an ancestor). */
	worktree?: AgentWorktree;
	/** Change summary of its own worktree when it finished ("2 changed files"). */
	worktreeStatus?: string;
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
	type: AgentTypeDef;
	/** Worktree bookkeeping after the agent ended (awaited by resume). */
	finishing?: Promise<void>;
	/** A resume is being set up (guards against a double resume). */
	resuming?: boolean;
}

export interface StartAgentOptions {
	name?: string;
	task: string;
	expectedOutput?: string;
	model: vscode.LanguageModelChat;
	allowWrite: boolean;
	maxSteps: number;
	/** `maxSteps` is a real limit (default true); false = only the safety cap. */
	stepLimit?: boolean;
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined;
	parentId?: string;
	session?: string;
	awaited?: boolean;
	type?: AgentTypeDef;
	/** Pre-assigned id (when a worktree was created for it first). */
	id?: string;
	worktree?: AgentWorktree;
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
	/**
	 * What to do (default "start"). One tool carries every agent operation:
	 * Copilot may hide our separate agent tools behind tool groups/search,
	 * but a model that can start agents can always wait for them.
	 */
	action?: "start" | "wait" | "status" | "message" | "stop" | "resume" | "types";
	/** Agent id/name for message / stop / resume / status details. */
	id?: string;
	/** Agents to wait for (action "wait"). */
	ids?: string[];
	/** Text for message / resume. */
	message?: string;
	/** Max wait for action "wait" (default 600, max 3600; 0 = just read). */
	timeoutSeconds?: number;
	task: string;
	name?: string;
	background?: boolean;
	expectedOutput?: string;
	model?: string;
	allowWrite?: boolean;
	maxSteps?: number;
	/** Agent type: general-purpose (default), Explore, Plan or a custom agent. */
	subagentType?: string;
	/** "worktree": run in an isolated git worktree. */
	isolation?: string;
}


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

/**
 * Whether agents started now may run shell commands without asking: the main
 * chat is in Autopilot, VS Code's global tool auto-approve is on, or the
 * user set `customcopilot.subagent.autoApproveCommands` to "always".
 */
function mainAutoApprove(): boolean {
	const mode = setting<string>("autoApproveCommands", "autopilot");
	if (mode === "always") {
		return true;
	}
	if (mode === "never") {
		return false;
	}
	const globalAuto = vscode.workspace.getConfiguration().get<boolean>("chat.tools.global.autoApprove", false) === true;
	return isAutopilotTurn() || globalAuto;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A short title for an agent whose caller gave no `name`: the gist of the
 * task, skipping boilerplate preambles ("Repo /path. Read AGENTS.md first.
 * Do NOT commit…") and preferring the text after a "Task:" marker.
 */
export function autoTitle(task: string): string {
	let text = String(task ?? "").replace(/\r/g, "");
	const marker = /(?:^|\n)\s*(?:#+\s*)?(?:task|goal|objective|задача)\s*:\s*/i.exec(text);
	if (marker) {
		text = text.slice(marker.index + marker[0].length);
	}
	const boiler = /^(repo|repository|workspace|project|cwd|context|note|read |do not|don't|never|you are|you're|important|strict|scope|rules?)\b/i;
	const sentences = text
		.split(/\n+|(?<=[.!?])\s+/)
		.map((t) => t.trim().replace(/^[-*•\d.)\s]+/, ""))
		.filter((t) => t.length > 3 && !boiler.test(t));
	let title = (sentences[0] ?? text.trim())
		.replace(/`|\*\*/g, "")
		.replace(/\s+/g, " ")
		.replace(/[.:;,]+$/, "");
	title = title.replace(/^(please\s+)?(task\s*:\s*)?/i, "");
	if (title.length > 60) {
		const cut = title.slice(0, 60);
		title = `${cut.slice(0, Math.max(30, cut.lastIndexOf(" ")))}…`;
	}
	return title ? title[0].toUpperCase() + title.slice(1) : "";
}

/** One-word "tasks" models send instead of setting `action`. */
const WAIT_WORDS = /^(wait|waiting|await|drain|poll|join|collect|check|results?|reports?|get[ _-]?reports?|read[ _-]?reports?|sync|block)$/i;
const STATUS_WORDS = /^(status|list|agents|progress|ls|show)$/i;
const JUNK_TASK = /^(placeholder|test|testing|probe|ping|hello|hi|ok|noop|no-op|dummy|example|todo|tbd|x+|\.+|-+|_+|none|null|empty)$/i;

/**
 * The operation a `delegateTask` call means. Weaker models often ignore the
 * `action` field and express it through `task` instead ("wait", "drain",
 * "status") or send a placeholder task while agents are running — they want
 * to wait. Inferring that beats rejecting (which made them loop).
 */
export function resolveAgentAction(
	input: { action?: string; task?: string; expectedOutput?: string },
	agentsActive: boolean
): string {
	const explicit = String(input.action ?? "").trim().toLowerCase();
	if (explicit && explicit !== "start") {
		return explicit;
	}
	const task = String(input.task ?? "").trim();
	if (!task) {
		return explicit === "start" ? "start" : agentsActive ? "wait" : "start";
	}
	if (WAIT_WORDS.test(task)) {
		return "wait";
	}
	if (STATUS_WORDS.test(task)) {
		return "status";
	}
	if (JUNK_TASK.test(task) && agentsActive) {
		return "wait";
	}
	return "start";
}

/** Consecutive report-started main turns that may still start auto-posting agents. */
const MAX_AUTO_RESUME_CHAIN = 3;

/** Shell commands that only pass time (busy-waiting for agents). */
const IDLE_COMMAND = /^\s*(sleep|timeout|wait|start-sleep|ping\s+-[nc]\s*\d+|read\s+-t|true|echo\b[^|;&]*)(\s|$)[^|;&]*$/i;

/**
 * True for a main-chat tool call that only waits on / polls background
 * agents (or burns time) — dropped while the chat is paused for them.
 * Starting more agents, messaging/stopping them and real work are kept.
 */
export function isIdleMainCall(name: string, input: unknown): boolean {
	const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	switch (name) {
		case AGENT_TOOL_NAMES.list:
		case AGENT_TOOL_NAMES.wait:
		case "manage_todo_list":
			return true;
		case AGENT_TOOL_NAMES.run: {
			const action = resolveAgentAction(args as { action?: string; task?: string }, true);
			return action === "wait" || action === "status" || action === "list";
		}
		case "run_in_terminal":
		case "copilot_runInTerminal":
			return IDLE_COMMAND.test(String(args.command ?? ""));
		default:
			return false;
	}
}

/** Text that ends a paused main-chat turn. */
export function pauseNotice(agents: { id: string; name: string }[]): string {
	const names = agents.map((a) => `«${a.name}» (${a.id})`).join(", ");
	return (
		`⏸ **Chat paused** — ${agents.length} background agent${agents.length > 1 ? "s are" : " is"} working: ${names}. ` +
		"Each report will be posted into this chat when its agent finishes, and the work continues from there. " +
		"Track them in the agent map (status bar → Agents)."
	);
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
	/** Main-chat turn the start counter belongs to. */
	private startsTurn = -1;
	private startsInTurn = 0;
	/** Main-chat turn that started background agents (it is paused after them). */
	private pauseTurn = -1;

	/** Pausing the main chat while its agents work is enabled. */
	pauseEnabled(): boolean {
		// Pausing only makes sense when reports are posted back to the chat.
		return setting("pauseChat", true) && setting("autoResume", true);
	}

	/**
	 * Agents the main chat should pause for in `turn`: running top-level
	 * agents when that turn started background work (pause enabled).
	 */
	/** A new user turn started: an earlier pause no longer applies. */
	clearPause(): void {
		this.pauseTurn = -1;
	}

	pauseFor(turn: number): AgentRecord[] {
		if (!this.pauseEnabled() || turn !== this.pauseTurn) {
			return [];
		}
		return this.list().filter((a) => a.status === "running" && a.parentId === MAIN_AGENT && !a.noAutoResume);
	}

	private readonly sessions = new Map<string, SessionInfo>();
	private mainContext: { tokens: number; modelName: string } | undefined;

	/** Append to an agent's work log (bounded). */
	log(r: AgentRecord, entry: Omit<TranscriptEntry, "at">): void {
		const text = entry.text.length > MAX_TRANSCRIPT_TEXT ? `${entry.text.slice(0, MAX_TRANSCRIPT_TEXT)}\n…[truncated]` : entry.text;
		r.transcript.push({ ...entry, text, at: Date.now() });
		if (r.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
			r.transcript.splice(1, r.transcript.length - MAX_TRANSCRIPT_ENTRIES);
		}
	}

	/** Title + model of the chat a top-level agent was started from (agent-map root). */
	noteSession(session: string | undefined, title: string, modelName: string | undefined): void {
		// Unknown session (proposal unavailable) → the "" root.
		const key = session ?? "";
		const prev = this.sessions.get(key);
		this.sessions.set(key, {
			session: key,
			title: prev?.title || title || "Chat",
			modelName: modelName ?? prev?.modelName ?? this.mainContext?.modelName,
			contextTokens: prev?.contextTokens ?? this.mainContext?.tokens,
		});
	}

	/** Context size of the main chat's latest request to OUR models. */
	noteMainContext(tokens: number, modelName: string): void {
		this.mainContext = { tokens, modelName };
		const s = this.sessions.get(this.lastActiveSession ?? "");
		if (s) {
			s.contextTokens = tokens;
			s.modelName = modelName;
			this.changeEmitter.fire();
		}
	}

	sessionInfos(): SessionInfo[] {
		return [...this.sessions.values()];
	}

	transcriptOf(idOrName: string): TranscriptEntry[] {
		return this.find(idOrName)?.record.transcript ?? [];
	}

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
			return `Error: ${maxConcurrent} agents are already running (customcopilot.subagent.maxConcurrent). Wait for one ({"action": "wait"}) or stop one ({"action": "stop", "id": "…"}).`;
		}
		const parent = opts.parentId && opts.parentId !== MAIN_AGENT ? this.agents.get(opts.parentId)?.record : undefined;
		const depth = parent ? parent.depth + 1 : 1;
		const id = opts.id ?? this.reserveId();
		const type = opts.type ?? BUILT_IN_TYPES[0];
		const record: AgentRecord = {
			id,
			name: (opts.name ?? "").trim() || autoTitle(opts.task) || id,
			task: opts.task,
			expectedOutput: opts.expectedOutput,
			modelId: opts.model.id,
			modelName: opts.model.name,
			status: "running",
			allowWrite: opts.allowWrite,
			maxSteps: opts.maxSteps,
			stepLimit: opts.stepLimit ?? true,
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
			totalTokens: 0,
			transcript: [],
			agentType: type.name,
			// Own worktree, else the parent's (children work in the same copy).
			worktree: opts.worktree ?? parent?.worktree,
		};
		const runtime: AgentRuntime = {
			record,
			type,
			model: opts.model,
			tools: pickTools(opts.allowWrite, depth < Math.max(1, setting("maxDepth", 3)), {
				tools: type.tools,
				disallowedTools: type.disallowedTools,
				mainTools: this.mainTools,
			}),
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
		logger.info("subagent.start", {
			id,
			type: type.name,
			parent: record.parentId,
			depth,
			model: opts.model.id,
			tools: runtime.tools.length,
			worktree: record.worktree?.path,
		});
		return record;
	}

	/** Next agent id ("a7"). */
	private reserveId(): string {
		return `a${this.nextId++}`;
	}

	/** Tools the main chat currently has enabled (from its last model request). */
	private mainTools: ReadonlySet<string> | undefined;

	/**
	 * Record the tool names of a main-chat request (its tool picker): agents
	 * started from now on get the same workspace tools.
	 */
	noteMainTools(names: readonly string[]): void {
		if (names.length > 0) {
			this.mainTools = new Set(names);
		}
	}

	/**
	 * `delegateTask` dispatcher (main chat and agents): action start (default)
	 * / wait / status / message / stop / resume. Returns the tool-result text.
	 */
	async control(
		caller: string,
		input: DelegateTaskInput,
		callerModel: vscode.LanguageModelChat | undefined,
		ctx: { toolInvocationToken: vscode.ChatParticipantToolToken | undefined; session?: string; token: vscode.CancellationToken }
	): Promise<string> {
		const action = resolveAgentAction(input, this.runningCount() > 0 || this.unreadNotifications(ctx.session) > 0);
		const id = String(input.id ?? "").trim();
		switch (action) {
			case "start":
				return this.delegate(caller, input, callerModel, ctx);
			case "list":
				return id ? this.details(id) ?? `No agent "${id}".` : this.describe(caller);
			case "status":
				return id ? this.details(id) ?? `No agent "${id}".` : this.describe(caller);
			case "message":
				return this.send(caller, id || MAIN_AGENT, String(input.message ?? ""));
			case "stop": {
				if (caller !== MAIN_AGENT) {
					const target = this.find(id);
					if (!target || !this.isDescendant(target.record, caller)) {
						return "Error: you can only stop your own sub-agents.";
					}
				} else if (id.toLowerCase() === "all") {
					this.stopAll();
					return "Stopping all running agents.";
				}
				const r = this.stop(id);
				return r ? `Stopping agent ${r.id} "${r.name}" (and its sub-agents).` : `No agent "${id}".`;
			}
			case "resume":
				return this.resume(caller, id, String(input.message ?? ""), { ...ctx, background: input.background !== false });
			case "wait":
				return this.waitAction(caller, input, ctx);
			case "types":
				return `Agent types for \`subagentType\`:\n${describeAgentTypes()}`;
			default:
				return `Error: unknown action "${action}" (use start, wait, status, message, stop, resume or types).`;
		}
	}

	/** action "wait": block until reports / messages arrive, then return them. */
	private async waitAction(
		caller: string,
		input: DelegateTaskInput,
		ctx: { session?: string; token: vscode.CancellationToken }
	): Promise<string> {
		const ids = Array.isArray(input.ids) ? input.ids.map(String) : input.id ? [String(input.id)] : undefined;
		const timeoutMs = Math.min(3600, Math.max(0, Number(input.timeoutSeconds ?? 600))) * 1000;
		if (caller !== MAIN_AGENT) {
			const runtime = this.agents.get(caller);
			if (!runtime) {
				return "Error: unknown caller.";
			}
			runtime.record.activity = "waiting for messages / sub-agents";
			this.changeEmitter.fire();
			await this.waitAgent(runtime, ids ?? this.list().filter((a) => a.parentId === caller).map((a) => a.id), timeoutMs);
			const inbox = runtime.record.inbox.length ? `\n\n${this.drainInbox(runtime)}` : "\n\nNo new messages.";
			return `${this.describe(caller)}${inbox}`;
		}
		const postable = this.list().filter((a) => a.status === "running" && a.parentId === MAIN_AGENT && !a.noAutoResume);
		if (this.pauseEnabled() && timeoutMs > 0 && postable.length > 0 && this.unreadNotifications(ctx.session) === 0) {
			// Do not hold the chat inside a tool call: the turn pauses and each
			// report is posted into the chat when its agent finishes.
			this.pauseTurn = currentMainTurn();
			return (
				"Agents are still running. The chat now PAUSES — end your turn with a one-line status for the user; " +
				"each report will be posted into this chat as a message when its agent finishes, and you continue then.\n\n" +
				this.describe(MAIN_AGENT)
			);
		}
		await this.waitMain(ids, timeoutMs, ctx.token, ctx.session);
		if (ctx.token.isCancellationRequested) {
			return "Cancelled.";
		}
		const pending = this.drainNotifications(ctx.session);
		const status = this.describe(MAIN_AGENT);
		if (pending.length === 0) {
			return (
				`No new agent reports yet.${this.runningCount() ? " Agents are still running — if you have nothing else to do, END YOUR TURN with a short status to the user; their reports will be posted into this chat and you continue then. Do not poll." : ""}` +
				`\n\n${status}`
			);
		}
		return `${formatNotifications(pending, 60_000, false)}\n\n## Agents\n${status}`;
	}

	/**
	 * Shared implementation of `delegateTask` start for the main chat and agents.
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
		// Placeholder / probe tasks: models sometimes "test" the tool. Never
		// start an agent for them (each one costs a full agent loop).
		const words = task.split(/\s+/).filter(Boolean);
		if (
			task.length < 25 ||
			words.length < 4 ||
			/^(placeholder|test|testing|probe|ping|hello|hi|ok|noop|dummy|example|todo|tbd)\b/i.test(task) ||
			/\breply\s+["'“]?ok["'”]?\s*(only)?\.?$/i.test(task)
		) {
			return (
				"Rejected: this looks like a placeholder or a test, not a real sub-task. Do NOT call this tool to test it or as a placeholder. " +
				"Only delegate substantial, self-contained work (several steps of research or implementation) with a detailed task description; do small things yourself and continue the user's task. " +
				'To WAIT for running agents call this same tool with {"action": "wait"}; for their status {"action": "status"}.'
			);
		}
		const parentRecord = caller !== MAIN_AGENT ? this.agents.get(caller)?.record : undefined;
		if (caller !== MAIN_AGENT) {
			const maxDepth = Math.max(1, setting("maxDepth", 3));
			if (!parentRecord || parentRecord.depth >= maxDepth) {
				return `Error: nesting limit reached (customcopilot.subagent.maxDepth = ${maxDepth}). Do the work yourself.`;
			}
		}
		if (caller === MAIN_AGENT) {
			// Runaway guard: a model that keeps spawning agents within one turn
			// (e.g. re-delegating after every agent update) is stopped here.
			const turn = currentMainTurn();
			if (turn !== this.startsTurn) {
				this.startsTurn = turn;
				this.startsInTurn = 0;
			}
			const maxPerTurn = Math.max(1, setting("maxStartsPerTurn", 6));
			if (this.startsInTurn >= maxPerTurn) {
				return `Error: ${maxPerTurn} agents were already started in this turn (customcopilot.subagent.maxStartsPerTurn). Do the remaining work yourself or wait for the running agents: call this tool with {"action": "wait"}.`;
			}
			this.startsInTurn++;
			if (input.background !== false) {
				// This turn launched background work: the chat pauses after it.
				this.pauseTurn = turn;
			}
		}
		const type = resolveAgentType(input.subagentType);
		if (!type) {
			return `Error: unknown subagentType "${input.subagentType}". Available types:\n${describeAgentTypes()}`;
		}
		// No round limit by default (Claude Code style); explicit limits win.
		const configured = Math.max(0, Math.floor(Number(setting("maxSteps", 0)) || 0));
		const requested = input.maxSteps ?? type.maxSteps ?? (configured > 0 ? configured : undefined);
		const stepLimit = requested !== undefined && Number(requested) > 0;
		const maxSteps = stepLimit ? Math.min(HARD_MAX_STEPS, Math.max(1, Math.floor(Number(requested)))) : HARD_MAX_STEPS;
		const isolation = String(input.isolation ?? type.isolation ?? "").trim().toLowerCase() === "worktree";
		// Write tools: asked for, implied by a custom type's tools, or an
		// isolated worktree (edits cannot touch the user's checkout) — never
		// for read-only types, and a read-only parent can never grant them.
		const isolatedCopy = isolation || !!parentRecord?.worktree;
		const allowWrite =
			!type.readOnly &&
			(input.allowWrite === true || type.write === true || (isolatedCopy && input.allowWrite !== false)) &&
			(parentRecord ? parentRecord.allowWrite : true);
		const modelHint = input.model ?? (type.model && type.model.toLowerCase() !== "inherit" ? type.model : undefined);
		const model = await selectModel(modelHint, callerModel);
		if (!model) {
			return "Error: no language model is available for the subagent.";
		}
		const maxConcurrent = Math.max(1, setting("maxConcurrent", 4));
		if (this.runningCount() >= maxConcurrent) {
			return `Error: ${maxConcurrent} agents are already running (customcopilot.subagent.maxConcurrent). Wait for one ({"action": "wait"}) or stop one ({"action": "stop", "id": "…"}).\n\n${this.describe(caller)}`;
		}
		const background = input.background !== false;
		const id = this.reserveId();
		let worktree: AgentWorktree | undefined;
		if (isolation) {
			const from = parentRecord?.worktree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!from) {
				return 'Error: isolation "worktree" needs an open workspace folder.';
			}
			try {
				worktree = await createAgentWorktree(id, from);
			} catch (err) {
				return `Error: could not create the worktree — ${err instanceof Error ? err.message : String(err)}. Start the agent without isolation, or fix the repository first.`;
			}
		}
		const started = this.start({
			id,
			name: input.name,
			task,
			expectedOutput: input.expectedOutput,
			model,
			allowWrite,
			maxSteps,
			stepLimit,
			toolInvocationToken: ctx.toolInvocationToken,
			parentId: caller,
			session: ctx.session,
			awaited: !background,
			type,
			worktree,
		});
		if (typeof started === "string") {
			if (worktree) {
				void removeAgentWorktree(worktree);
			}
			return `${started}\n\n${this.describe(caller)}`;
		}
		if (caller === MAIN_AGENT && autoResumeDepth() >= MAX_AUTO_RESUME_CHAIN) {
			// Report → agents → report … with no user message in between:
			// stop the chain here (reports stay readable via "wait").
			started.noAutoResume = true;
		} else if (parentRecord?.noAutoResume) {
			started.noAutoResume = true;
		}
		started.autoApprove = parentRecord ? parentRecord.autoApprove === true : mainAutoApprove();
		if (!background) {
			const done = await this.waitFor(started.id, ctx.token);
			return `[Subagent ${started.id} "${started.name}" (${type.name}) — ${model.name}, ${done?.status}, ${done?.steps} rounds, ${done?.toolCalls} tool calls]\n\n${done?.report ?? done?.error ?? ""}${this.worktreeFooter(started)}`;
		}
		const head =
			`Started background agent ${started.id} "${started.name}" (${type.name}) on ${model.name} [${model.id}] (${allowWrite ? "read/write" : "read-only"}, ${stepLimit ? `up to ${maxSteps} rounds` : "no round limit"})` +
			(worktree ? ` in its own worktree ${worktree.path} (branch ${worktree.branch}).` : ".");
		if (caller !== MAIN_AGENT) {
			return `${head} Its report arrives as a message at the start of one of your next rounds; {"action": "wait"} blocks until it does.`;
		}
		if (this.pauseEnabled() && !started.noAutoResume) {
			return (
				`${head}\n` +
				"Start any other agents you need now (in this same response if possible), then END YOUR TURN with a short status for the user. " +
				"The chat PAUSES while agents run — waiting, polling, sleep or todo updates are not executed. " +
				"Each report is posted into this chat as a message when its agent finishes, and you continue the user's task from there. " +
				`Steer the agent with {"action": "message", "id": "${started.id}", "message": "…"}.`
			);
		}
		return (
			`${head}\n` +
			"You do NOT need to stay active while it runs. Do other useful work for the user if there is any; " +
			"otherwise END YOUR TURN now with a short status message to the user (what is running and what happens next) — " +
			"when the agent finishes, its report is posted into this chat automatically and you continue from there. " +
			'Only if you need the result before you can continue this turn, call this tool with {"action": "wait"} (it blocks until a report arrives). ' +
			"Never poll with shell commands, sleep, todo updates or placeholder calls. " +
			`Steer the agent with {"action": "message", "id": "${started.id}", "message": "…"}.`
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
		if (r.status === "running" || runtime.resuming) {
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
		const configuredBudget = Math.max(0, Math.floor(Number(setting("maxSteps", 0)) || 0));
		const budget = r.stepLimit && configuredBudget > 0 ? configuredBudget : HARD_MAX_STEPS;
		// Held until the agent is marked running (no double resume across the awaits below).
		runtime.resuming = true;
		// Let the end-of-run worktree bookkeeping finish first (it may remove it).
		await runtime.finishing?.catch(() => undefined);
		let worktreeNote = "";
		if (r.worktree && !r.worktree.removed && r.worktree.owner === r.id) {
			await setWorktreeLock(r.worktree, true);
		}
		if (r.worktree?.removed && r.worktree.owner === r.id) {
			// Its worktree had no changes and was removed: give it a fresh one.
			const old = r.worktree;
			try {
				r.worktree = await createAgentWorktree(r.id, old.checkoutRoot);
				r.worktreeStatus = undefined;
				worktreeNote = `\n\nYour previous worktree had no changes and was removed. You now work in a fresh isolated worktree at ${r.worktree.path} (branch ${r.worktree.branch}); it replaces ${old.path} in everything above.`;
			} catch (err) {
				runtime.resuming = false;
				return `Error: could not recreate the agent's worktree — ${err instanceof Error ? err.message : String(err)}.`;
			}
		}
		r.status = "running";
		runtime.resuming = false;
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
		if (caller === MAIN_AGENT) {
			r.autoApprove = mainAutoApprove();
		}
		runtime.messages.push(
			vscode.LanguageModelChatMessage.User(
				`[Resumed by ${caller === MAIN_AGENT ? "the main agent" : `agent ${caller}`}] ${text}\n\n(${r.stepLimit ? `Up to ${budget} more tool rounds. ` : ""}Finish with an updated report.)${worktreeNote}`
			)
		);
		this.log(r, { kind: "resume", text: `Resumed by ${caller === MAIN_AGENT ? "the main agent" : `agent ${caller}`}: ${text}` });
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

	/**
	 * Notifications the main chat should be NOTICED about on its next model
	 * request: those of the chat our tools were last called from (the
	 * provider does not know the session) plus unscoped ones, at most twice
	 * each and not older than an hour — a notice the main agent cannot act
	 * on (e.g. another chat's report) must never repeat forever, it makes
	 * models probe tools in a loop. Marks the returned ones as noticed.
	 */
	takeNoticeCount(): number {
		const now = Date.now();
		// Drop stale unread notifications entirely.
		const fresh = this.notifications.filter((n) => now - n.at < 60 * 60_000);
		if (fresh.length !== this.notifications.length) {
			this.notifications.splice(0, this.notifications.length, ...fresh);
		}
		const due = this.notifications.filter(
			(n) => (!n.session || n.session === this.lastActiveSession) && (n.noticed ?? 0) < 2
		);
		for (const n of due) {
			n.noticed = (n.noticed ?? 0) + 1;
		}
		return due.length;
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
			const wt = a.worktree ? `, worktree ${a.worktree.removed ? "(removed)" : a.worktree.path}` : "";
			return `${indent}- ${a.id} "${a.name}"${me} (${a.agentType}${wt}) [${status}] parent=${a.parentId}, model=${a.modelName} [${a.modelId}], ${contextLabel(a)}, ${a.stepLimit ? `${a.steps}/${a.maxSteps}` : a.steps} rounds, ${a.toolCalls} tool calls, ${age}${a.inbox.length ? `, ${a.inbox.length} unread msg` : ""}\n${indent}  task: ${a.task.length > 160 ? `${a.task.slice(0, 157)}…` : a.task}`;
		});
		const unread =
			viewer === MAIN_AGENT && this.notifications.length
				? `\n\n${this.notifications.length} unread notification(s) for main — read them with {"action": "wait", "timeoutSeconds": 0}.`
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
			`${r.id} "${r.name}" (${r.agentType}) [${r.status}] parent=${r.parentId}, model=${r.modelName} [${r.modelId}], ${r.steps} rounds, ${r.toolCalls} tool calls`,
			r.worktree
				? `Worktree: ${r.worktree.path} (branch ${r.worktree.branch}${r.worktree.owner !== r.id ? `, inherited from ${r.worktree.owner}` : ""})${r.worktree.removed ? " — removed" : r.worktreeStatus ? ` — ${r.worktreeStatus}` : ""}`
				: "",
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
			this.notify({
				kind: "message",
				agentId: from,
				agentName: fromName,
				text: body,
				at: Date.now(),
				session: fromRecord?.session,
				quiet: fromRecord?.noAutoResume === true,
			});
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
			quiet: r.stoppedByUser === true || r.noAutoResume === true,
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

	/**
	 * Whether something may be posted into the chat now: "busy" (a turn is
	 * running or a waiter is blocked — try later), "stopped" (the user pressed
	 * Stop: VS Code holds its queue, posting would raise the pending-requests
	 * dialog — ask the user instead) or "ready".
	 */
	chatPostState(idleMs = Math.max(1000, setting("autoResumeIdleMs", 5000))): "busy" | "stopped" | "ready" {
		if (this.mainWaiters.size > 0 || !isMainChatIdle(idleMs)) {
			return "busy";
		}
		return wasMainTurnCancelled() ? "stopped" : "ready";
	}

	/** The chat session our tools were last called from (≈ the focused chat). */
	activeSession(): string | undefined {
		return this.lastActiveSession;
	}

	/** Post pending notifications to their chat sessions as new messages. */
	private async autoResume(): Promise<void> {
		if (wasMainTurnCancelled()) {
			// The user stopped the chat: its queue is paused, and posting would
			// pop VS Code's "pending requests" dialog. Ask instead.
			const names = this.notifications.filter((n) => !n.quiet).map((n) => `«${n.agentName}»`);
			if (names.length === 0) {
				return;
			}
			void vscode.window
				.showInformationMessage(`Background agent ${names.join(", ")} finished.`, "Post report to chat", "Show agent map")
				.then(async (choice) => {
					if (choice === "Post report to chat") {
						noteMainCancelled(false);
						await this.autoResume();
					} else if (choice === "Show agent map") {
						void vscode.commands.executeCommand("customcopilot.showAgentMap");
					}
				});
			return;
		}
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
				await this.postToChat(session || undefined, query);
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
	async postToChat(session: string | undefined, query: string): Promise<void> {
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
		// A resumed agent continues its kept conversation.
		if (runtime.messages.length === 0) {
			const system = subagentSystemPrompt({
				id: r.id,
				name: r.name,
				type: runtime.type,
				parent: r.parentId === MAIN_AGENT ? "the main agent" : `agent ${r.parentId}`,
				canSpawn,
				allowWrite: r.allowWrite,
				maxSteps: r.maxSteps,
				stepLimit: r.stepLimit,
				modelName: runtime.model.name,
				worktree: r.worktree,
				inheritedWorktree: !!r.worktree && r.worktree.owner !== r.id,
				gitBranch: await currentBranch(r.worktree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()).catch(() => undefined),
			});
			runtime.messages.push(vscode.LanguageModelChatMessage.User(subagentFirstMessage(system, r.task, r.expectedOutput)));
			this.log(r, { kind: "task", text: `${r.task}${r.expectedOutput ? `\n\nExpected report: ${r.expectedOutput}` : ""}` });
		}
		const messages = runtime.messages;
		let finalText = "";
		/** Rounds the model kept calling tools after the budget was exhausted. */
		let overrun = 0;
		/** Signature of the previous tool round and how often it repeated. */
		let lastSignature = "";
		let repeats = 0;
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
				this.logTurn(r, turn);
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
				// Loop detector (there is no round limit by default): the very same
				// calls round after round mean the agent is stuck.
				// Waiting on / checking sub-agents may legitimately repeat — not counted.
				const coordinationOnly = calls.every(
					(c) =>
						c.name === AGENT_TOOL_NAMES.wait ||
						c.name === AGENT_TOOL_NAMES.list ||
						(c.name === AGENT_TOOL_NAMES.run && ["wait", "status", "list"].includes(resolveAgentAction(c.input as DelegateTaskInput, true)))
				);
				const signature = coordinationOnly ? "" : calls.map((c) => `${c.name}:${JSON.stringify(c.input ?? {})}`).join("|");
				repeats = signature && signature === lastSignature ? repeats + 1 : signature ? 1 : 0;
				lastSignature = signature;
				const stuck = repeats >= REPEAT_STOP;
				if (lastRound || stuck) {
					// Budget exhausted: answer the calls without running them.
					overrun++;
					for (const call of calls) {
						results.push(
							new vscode.LanguageModelToolResultPart(call.callId, [
								new vscode.LanguageModelTextPart(
									stuck
										? `Not executed: you made this exact call ${repeats} times in a row. Stop repeating it and write your final report now with what you have.`
										: r.stepLimit
											? "Not executed: the step budget is exhausted. Write your final report now."
											: `Not executed: the safety cap of ${HARD_MAX_STEPS} rounds is reached. Write your final report now.`
								),
							])
						);
					}
					messages.push(vscode.LanguageModelChatMessage.User(results));
					if (overrun >= 2) {
						finalText = text || `(no report — ${stuck ? "the agent kept repeating the same tool call" : "the step budget was exhausted"} while it kept calling tools)`;
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
					this.log(r, { kind: "result", tool: call.name, text: resultText });
				}
				if (r.inbox.length > 0) {
					results.push(new vscode.LanguageModelTextPart(this.drainInbox(runtime)));
				}
				if (repeats >= REPEAT_WARN) {
					results.push(
						new vscode.LanguageModelTextPart(
							`Note: this is the ${repeats}th time in a row you made exactly the same tool call(s) and got the same kind of result. Change your approach (other tool, other arguments, other hypothesis) or, if you are done, write your final report.`
						)
					);
				}
				if (r.steps >= r.maxSteps) {
					results.push(new vscode.LanguageModelTextPart("Step budget reached. Write your final report now, without calling tools."));
				}
				messages.push(vscode.LanguageModelChatMessage.User(results));
			}
			r.report = truncate(finalText.trim() || "(the agent returned an empty report)", MAX_REPORT_CHARS, "report");
			r.status = "done";
			this.log(r, { kind: "report", text: r.report });
		} catch (err) {
			if (isCancellation(err) || token.isCancellationRequested) {
				r.status = "stopped";
				r.error = r.stoppedByUser ? "stopped by the user" : "stopped before finishing";
			} else {
				r.status = "failed";
				r.error = err instanceof Error ? err.message : String(err);
				this.log(r, { kind: "error", text: r.error });
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
			await this.finishWorktree(r);
			this.report(
				r,
				(r.status === "done" ? r.report ?? "" : `${r.status.toUpperCase()}: ${r.error ?? ""}${r.report ? `\n${r.report}` : ""}`) +
					this.worktreeFooter(r) +
					tail
			);
		}
	}

	/** Log a model response (thinking, text, tool calls) to the work log. */
	private logTurn(r: AgentRecord, turn: AgentTurn): void {
		const thinking = turn.thinking
			.map((t) => (Array.isArray(t.value) ? t.value.join("") : t.value))
			.join("")
			.trim();
		if (thinking) {
			this.log(r, { kind: "thinking", text: thinking });
		}
		if (turn.text.trim()) {
			this.log(r, { kind: "text", text: turn.text.trim() });
		}
		for (const c of turn.calls) {
			let args = "";
			try {
				args = JSON.stringify(c.input ?? {}, null, 1);
			} catch {
				args = String(c.input);
			}
			this.log(r, { kind: "tool", tool: c.name, text: args });
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
		const totalBefore = r.totalTokens;
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
						r.totalTokens += total;
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
		if (r.totalTokens === totalBefore) {
			// No usage from the provider (non-own model): estimate.
			r.totalTokens += estimateTokens(messages) + Math.ceil(text.length / 3.5);
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
		this.log(r, { kind: "compact", text: summary.trim() ? `Context compacted. Summary:\n${summary.trim()}` : "Context trimmed (summary unavailable)." });
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
		for (const m of msgs) {
			this.log(runtime.record, { kind: "inbox", text: `From ${m.from}: ${m.text}` });
		}
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
				return this.control(id, input as unknown as DelegateTaskInput, runtime.model, {
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
		if (!runtime.record.allowWrite && call.name !== AGENT_TOOL_NAMES.runCommand) {
			return "Error: this agent is read-only (it can run commands, but not edit files).";
		}
		try {
			switch (call.name) {
				case AGENT_TOOL_NAMES.editFile:
					return await agentEditFile(input, runtime.record.worktree);
				case AGENT_TOOL_NAMES.createFile:
					return await agentCreateFile(input, runtime.record.worktree);
				default:
					return await agentRunCommand(input, {
						worktree: runtime.record.worktree,
						agentLabel: `${runtime.record.id} "${runtime.record.name}"`,
						autoApprove: runtime.record.autoApprove === true,
						allowAll: runtime.allowAllCommands,
						onWaiting: (cmd) => {
							runtime.record.activity = cmd ? `waiting for approval: ${cmd.slice(0, 60)}` : "running command";
							this.changeEmitter.fire();
						},
						token: runtime.cts.token,
					});
			}
		} catch (err) {
			return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	// ── Worktrees ──────────────────────────────────────────────────────

	/** Agents still running inside `wt` (the owner and/or inheriting sub-agents). */
	private worktreeUsers(wt: AgentWorktree): AgentRecord[] {
		return this.list().filter((a) => a.status === "running" && a.worktree === wt);
	}

	/**
	 * When the OWNER of a worktree ends: remove it if nothing changed (and no
	 * sub-agent still works in it), else keep it and remember the summary.
	 * Sub-agents ending in an inherited worktree retry the cleanup.
	 */
	private async finishWorktree(r: AgentRecord): Promise<void> {
		const wt = r.worktree;
		if (!wt || wt.removed) {
			return;
		}
		const runtime = this.agents.get(wt.owner);
		const work = (async () => {
			const owner = runtime?.record;
			if (!owner) {
				return;
			}
			const busy = () => owner.status === "running" || runtime?.resuming === true || this.worktreeUsers(wt).length > 0;
			if (busy()) {
				return;
			}
			try {
				const changes = await worktreeChanges(wt);
				// Resumed (or a sub-agent started) meanwhile: leave it alone.
				if (busy()) {
					return;
				}
				if (changes && changes.files === 0 && changes.commits === 0) {
					await removeAgentWorktree(wt);
					owner.worktreeStatus = "no changes — worktree removed";
				} else {
					// Kept for review: unlock it so a later cleanup may consider it
					// (cleanups only ever remove unchanged worktrees).
					await setWorktreeLock(wt, false);
					owner.worktreeStatus = changes ? describeChanges(changes) : "kept (state unknown)";
				}
			} catch (err) {
				owner.worktreeStatus = `kept (${err instanceof Error ? err.message : String(err)})`;
			}
			this.changeEmitter.fire();
		})();
		if (runtime) {
			runtime.finishing = work;
		}
		await work;
	}


	/** "[Worktree] …" lines appended to a report (own worktree only). */
	private worktreeFooter(r: AgentRecord): string {
		const wt = r.worktree;
		if (!wt || wt.owner !== r.id) {
			return "";
		}
		if (wt.removed) {
			return "\n\n[Worktree] No changes were made — the worktree was removed.";
		}
		return (
			`\n\n[Worktree] Changes are in ${wt.path} (branch ${wt.branch}, based on ${wt.base.slice(0, 12)}): ${r.worktreeStatus ?? "still in use by sub-agents"}. ` +
			"The user's checkout is untouched. Review with `git -C <path> status` / `git -C <path> diff`; the user can apply them to the workspace from the agent's details (Apply to workspace) or merge the branch."
		);
	}

	/** Worktree of an agent (UI). */
	worktreeOf(idOrName: string): AgentWorktree | undefined {
		return this.find(idOrName)?.record.worktree;
	}

	/** Apply an agent's worktree changes to the main checkout (UI). */
	async applyWorktree(idOrName: string): Promise<string> {
		const r = this.find(idOrName)?.record;
		if (!r?.worktree) {
			throw new Error("This agent has no worktree.");
		}
		if (this.worktreeUsers(r.worktree).length > 0) {
			throw new Error("Agents are still working in this worktree — stop them or wait until they finish.");
		}
		return applyWorktreeToMain(r.worktree);
	}

	/** Delete an agent's worktree and branch (UI). */
	async removeWorktree(idOrName: string): Promise<boolean> {
		const r = this.find(idOrName)?.record;
		if (!r?.worktree) {
			return false;
		}
		if (this.worktreeUsers(r.worktree).length > 0) {
			throw new Error("Agents are still working in this worktree — stop them first.");
		}
		const ok = await removeAgentWorktree(r.worktree);
		if (ok) {
			const owner = this.agents.get(r.worktree.owner)?.record ?? r;
			owner.worktreeStatus = "worktree removed";
			this.changeEmitter.fire();
		}
		return ok;
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
			const wt = runtime.record.worktree;
			return await vscode.lm.invokeTool(
				call.name,
				{ input: wt ? (remapPaths(call.input, wt) as object) : call.input, toolInvocationToken: runtime.toolInvocationToken },
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
			// Keep agents whose kept worktree still awaits review (Apply / Remove live on the record).
			.filter((r) => !(r.record.worktree && r.record.worktree.owner === r.record.id && !r.record.worktree.removed))
			.sort((a, b) => (a.record.endedAt ?? 0) - (b.record.endedAt ?? 0));
		for (const r of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_AGENTS))) {
			disposeAgentTerminal(`${r.record.id} "${r.record.name}"`);
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

/**
 * Re-root absolute paths (plain or file:// URIs) under the main checkout
 * into the agent's worktree, in any string field of a tool input.
 */
function remapPaths(input: unknown, wt: AgentWorktree, depth = 0): unknown {
	if (depth > 6) {
		return input;
	}
	if (typeof input === "string") {
		if (input.startsWith("file://")) {
			try {
				const fsPath = vscode.Uri.parse(input).fsPath;
				const mapped = toWorktreePath(fsPath, wt);
				return mapped === fsPath ? input : vscode.Uri.file(mapped).toString();
			} catch {
				return input;
			}
		}
		// Only absolute paths (relative strings are not necessarily paths).
		return input.length < 4096 && pathModule.isAbsolute(input) ? toWorktreePath(input, wt) : input;
	}
	if (Array.isArray(input)) {
		return input.map((v) => remapPaths(v, wt, depth + 1));
	}
	if (input && typeof input === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
			out[k] = remapPaths(v, wt, depth + 1);
		}
		return out;
	}
	return input;
}

/** Render notifications for the main agent (tool result or auto-resume message). */
export function formatNotifications(items: AgentNotification[], maxReportChars: number, forChat: boolean): string {
	const blocks = items.map((n) =>
		n.kind === "finished"
			? `### 📨 Agent «${n.agentName}» (${n.agentId}) finished\n\n${truncate(n.text, maxReportChars, `report — {"action": "status", "id": "${n.agentId}"} shows the full text`)}`
			: `### 💬 Message from agent «${n.agentName}» (${n.agentId})\n\n${n.text}`
	);
	if (!forChat) {
		return `${items.length} notification(s):\n\n${blocks.join("\n\n")}`;
	}
	const running = agentManager.runningCount();
	return (
		`${AUTO_RESUME_HEADER}${items.length > 1 ? `s (${items.length})` : ""}\n\n${blocks.join("\n\n---\n\n")}\n\n---\n` +
		`_These are reports of background agents YOU started earlier in this chat. Continue the user's original task with them${running ? ` (${running} agent(s) still running — their reports will follow)` : ""}. Do not start agents just to acknowledge this._`
	);
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
	if (agentManager.unreadNotifications() === 0) {
		return messages;
	}
	const first = messages.find((m) => m.role === vscode.LanguageModelChatMessageRole.User);
	const firstText = first?.content.find((p) => p instanceof vscode.LanguageModelTextPart) as vscode.LanguageModelTextPart | undefined;
	if (firstText?.value.startsWith(SUBAGENT_SENTINEL)) {
		return messages;
	}
	const unread = agentManager.takeNoticeCount();
	if (unread === 0) {
		return messages;
	}
	const running = agentManager.runningCount();
	const noticeText = `[System notice] ${unread} background agent notification(s) are waiting (agent reports / messages)${running ? `; ${running} agent(s) still running` : ""}. Read them with the customcopilot_delegateTask tool: {"action": "wait", "timeoutSeconds": 0}.`;
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
