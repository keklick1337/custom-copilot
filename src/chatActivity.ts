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
