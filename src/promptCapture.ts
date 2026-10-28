import { promises as fsp } from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { logger } from "./logger";

/**
 * Captures the most recent ORIGINAL system prompt that Copilot Chat assembled
 * and sent to this provider, so the user can view it in the configuration UI
 * and use it as a starting point for their override.
 *
 * Capture happens on every chat request (even when the override feature is
 * disabled) via {@link captureSystemPrompt}, called from `applyPromptOverride`
 * BEFORE any rewriting. The latest value is kept in memory only. It is mirrored
 * to disk (asynchronously, so a chat request never blocks on file I/O) ONLY when
 * the user opted into something that already implies persisting prompt content:
 * `customcopilot.promptOverride.enabled` or `customcopilot.logMessageContent`.
 */

interface CapturedPrompt {
	/** The original combined system prompt text (pre-override). */
	text: string;
	/** Epoch ms when it was captured. */
	capturedAt: number;
	/** The model id the prompt was captured for, when known. */
	modelId?: string;
}

let lastCaptured: CapturedPrompt | undefined;
/** Text of the last successful disk write, to skip identical rewrites. */
let lastPersistedText: string | undefined;
/** Serialises disk writes so an older capture can never overwrite a newer one. */
let writeChain: Promise<void> = Promise.resolve();
let staleFileRemoved = false;
let persistedLoad: Promise<void> | undefined;

function captureFilePath(): string {
	return path.join(os.homedir(), ".copilot", "customcopilot", "last-system-prompt.json");
}

function isPersistenceAllowed(): boolean {
	try {
		const config = vscode.workspace.getConfiguration();
		return (
			config.get<boolean>("customcopilot.promptOverride.enabled", false) === true ||
			config.get<boolean>("customcopilot.logMessageContent", false) === true
		);
	} catch {
		return false;
	}
}

async function persist(captured: CapturedPrompt): Promise<void> {
	if (captured.text === lastPersistedText) {
		return;
	}
	const filePath = captureFilePath();
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, JSON.stringify(captured), { encoding: "utf8", mode: 0o600 });
	// `mode` only applies on creation — tighten a file left by older versions.
	await fsp.chmod(filePath, 0o600).catch(() => undefined);
	lastPersistedText = captured.text;
}

/** Remove a prompt persisted by an earlier version / while persistence was on. */
async function removeStaleFile(): Promise<void> {
	if (staleFileRemoved) {
		return;
	}
	staleFileRemoved = true;
	try {
		await fsp.unlink(captureFilePath());
	} catch {
		/* not present — nothing to remove */
	}
	lastPersistedText = undefined;
}

/**
 * Record the original system prompt. Stores it in memory and, when persistence
 * is allowed, schedules a best-effort async write. Never throws — capture must
 * never break a chat request.
 */
export function captureSystemPrompt(text: string, modelId?: string): void {
	const captured: CapturedPrompt = { text, capturedAt: Date.now(), modelId };
	lastCaptured = captured;
	const allowed = isPersistenceAllowed();
	if (allowed) {
		staleFileRemoved = false;
	}
	writeChain = writeChain
		.then(() => (allowed ? persist(captured) : removeStaleFile()))
		.catch((e) => {
			logger.warn("promptCapture.write.error", { error: e instanceof Error ? e.message : String(e) });
		});
}

/**
 * Load a previously persisted capture (only when persistence is allowed) so the
 * UI can show it right after an extension-host reload. Safe to call repeatedly.
 */
export function loadPersistedSystemPrompt(): Promise<void> {
	if (!persistedLoad) {
		persistedLoad = (async () => {
			if (lastCaptured || !isPersistenceAllowed()) {
				return;
			}
			try {
				const raw = await fsp.readFile(captureFilePath(), "utf8");
				const parsed = JSON.parse(raw) as CapturedPrompt;
				if (!lastCaptured && parsed && typeof parsed.text === "string") {
					lastCaptured = parsed;
					lastPersistedText = parsed.text;
				}
			} catch (e) {
				const code = (e as NodeJS.ErrnoException)?.code;
				if (code !== "ENOENT") {
					logger.warn("promptCapture.read.error", { error: e instanceof Error ? e.message : String(e) });
				}
			}
		})();
	}
	return persistedLoad;
}

/**
 * Return the most recently captured system prompt, or `undefined` if none has
 * been captured yet. Call {@link loadPersistedSystemPrompt} first to include a
 * capture persisted before an extension-host reload.
 */
export function getCapturedSystemPrompt(): CapturedPrompt | undefined {
	return lastCaptured;
}

/**
 * Activation hook: delete a prompt file left on disk by an earlier version
 * when persistence is not allowed (instead of waiting for the first chat).
 */
export function cleanupPersistedPromptOnActivation(): void {
	if (!isPersistenceAllowed()) {
		void removeStaleFile();
	}
}
