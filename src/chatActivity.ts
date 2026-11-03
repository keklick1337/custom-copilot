import * as vscode from "vscode";

/**
 * Tracks when this extension's chat provider actually starts handling a request.
 *
 * VS Code only persists a chat session that has at least one registered request (or a
 * custom title); an empty session is deleted when it is disposed (see VS Code
 * `chatServiceImpl.ts` → `willDisposeModel`). When the Chat Generator launches many
 * sessions and switches between them with `workbench.action.chat.newChat`, a session can
 * be disposed *before* its request has been registered, which silently drops it.
 *
 * `provideLanguageModelChatResponse` is invoked only after VS Code has already added the
 * request to the session model, so it is a reliable "the request is now persisted" signal.
 * The launcher waits for this signal before creating the next session.
 */
let requestStartCount = 0;
const onDidStartRequestEmitter = new vscode.EventEmitter<void>();

/** Fired every time the chat provider begins handling a request. */
export const onDidStartChatRequest = onDidStartRequestEmitter.event;

/** Monotonic counter of chat requests this provider has started handling. */
export function getChatRequestStartCount(): number {
	return requestStartCount;
}

/** Called by the provider at the very start of handling a request. */
export function notifyChatRequestStart(): void {
	requestStartCount++;
	onDidStartRequestEmitter.fire();
}

/**
 * Resolves once a new chat request has started (the start count went above
 * {@link previousCount}), the cancellation token is triggered, or the timeout elapses.
 * @returns `true` if a new request started, `false` if it timed out / was cancelled.
 */
export function waitForChatRequestStart(
	previousCount: number,
	timeoutMs: number,
	token?: vscode.CancellationToken
): Promise<boolean> {
	if (requestStartCount > previousCount) {
		return Promise.resolve(true);
	}
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (started: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			listener.dispose();
			tokenListener?.dispose();
			resolve(started);
		};
		const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
		const listener = onDidStartRequestEmitter.event(() => {
			if (requestStartCount > previousCount) {
				finish(true);
			}
		});
		const tokenListener = token?.onCancellationRequested(() => finish(false));
	});
}

// ---------------------------------------------------------------------------
// Main-chat activity (used by background subagents to decide when the main
// chat is idle and can be resumed with their reports).
// ---------------------------------------------------------------------------

let activeMainRequests = 0;
let lastMainActivity = 0;

/** Mark the start of a main-chat activity (a model request or one of our tool calls). */
export function beginMainActivity(): void {
	activeMainRequests++;
	lastMainActivity = Date.now();
}

/** Mark the end of a main-chat activity started with {@link beginMainActivity}. */
export function endMainActivity(): void {
	activeMainRequests = Math.max(0, activeMainRequests - 1);
	lastMainActivity = Date.now();
}

/**
 * True when no main-chat request is in flight and nothing happened for at
 * least `idleMs` (the agent loop runs tools between model requests, so a
 * short gap alone does not mean the turn is over).
 */
export function isMainChatIdle(idleMs: number): boolean {
	if (activeMainRequests > 0) {
		return false;
	}
	const quiet = Date.now() - lastMainActivity;
	// The last agent-loop response asked for tools: the turn is still going
	// (tools running, or a confirmation pending — posting now would cancel
	// it). Assume it ended only after a long silence (e.g. the user stopped it).
	return lastMainResponseCalledTools ? quiet >= TURN_STALE_MS : quiet >= idleMs;
}

/** After this long without activity a turn that last called tools counts as over. */
const TURN_STALE_MS = 10 * 60_000;
let lastMainResponseCalledTools = false;

/**
 * Record how a main-chat agent-loop response (a request that offered tools)
 * ended: with tool calls (turn continues) or without (turn finished).
 */
export function noteMainResponse(calledTools: boolean): void {
	lastMainResponseCalledTools = calledTools;
	lastMainActivity = Date.now();
}

// ---------------------------------------------------------------------------
// Main-chat turn identity (spawn limits / auto-resume loop guard).
// ---------------------------------------------------------------------------

let mainTurnKey = "";
let mainTurnIsAutoResume = false;
let mainTurnSeq = 0;

/**
 * Record the user message of the current main-chat turn (called for every
 * agent-loop request; the same message across rounds = the same turn).
 */
export function noteMainTurn(userText: string, isAutoResume: boolean): void {
	const key = `${userText.length}:${userText.slice(0, 200)}:${userText.slice(-200)}`;
	if (key !== mainTurnKey) {
		mainTurnKey = key;
		mainTurnSeq++;
	}
	mainTurnIsAutoResume = isAutoResume;
}

/** Monotonic id of the current main-chat turn. */
export function currentMainTurn(): number {
	return mainTurnSeq;
}

/** True when the current main turn was started by an auto-resume message. */
export function isAutoResumeTurn(): boolean {
	return mainTurnIsAutoResume;
}
