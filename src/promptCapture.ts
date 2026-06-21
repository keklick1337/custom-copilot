import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger";

/**
 * Captures the most recent ORIGINAL system prompt that Copilot Chat assembled
 * and sent to this provider, so the user can view it in the configuration UI
 * and use it as a starting point for their override.
 *
 * Capture happens on every chat request (even when the override feature is
 * disabled) via {@link captureSystemPrompt}, called from `applyPromptOverride`
 * BEFORE any rewriting. The latest value is kept in memory for instant access
 * and mirrored to a file so it survives an extension-host reload.
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

function captureFilePath(): string {
	return path.join(os.homedir(), ".copilot", "customcopilot", "last-system-prompt.json");
}

/**
 * Record the original system prompt. Stores it in memory and (best-effort)
 * persists it to disk. Never throws — capture must never break a chat request.
 */
export function captureSystemPrompt(text: string, modelId?: string): void {
	try {
		lastCaptured = { text, capturedAt: Date.now(), modelId };
		const filePath = captureFilePath();
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(lastCaptured), "utf8");
	} catch (e) {
		logger.warn("promptCapture.write.error", { error: e instanceof Error ? e.message : String(e) });
	}
}

/**
 * Return the most recently captured system prompt, or `undefined` if none has
 * been captured yet. Falls back to the persisted file when the in-memory copy
 * is empty (e.g. right after an extension-host reload).
 */
export function getCapturedSystemPrompt(): CapturedPrompt | undefined {
	if (lastCaptured) {
		return lastCaptured;
	}
	try {
		const filePath = captureFilePath();
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(raw) as CapturedPrompt;
			if (parsed && typeof parsed.text === "string") {
				lastCaptured = parsed;
				return lastCaptured;
			}
		}
	} catch (e) {
		logger.warn("promptCapture.read.error", { error: e instanceof Error ? e.message : String(e) });
	}
	return undefined;
}
