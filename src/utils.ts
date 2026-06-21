import * as vscode from "vscode";
import type { HFModelItem, RetryConfig } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";

import { logger } from "./logger";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// HTTP status codes that are PERMANENT for this request body and must NEVER be
// retried or key-rotated: the payload itself is the problem, so re-sending it
// (even with a different key) just wastes attempts. 413 = body too large,
// 414 = URI too long, 431 = headers too large, 400/422 = malformed/invalid
// request. These win even if the user added them to the retryable list.
const NON_RETRYABLE_STATUS_CODES = [400, 413, 414, 422, 431];

/**
 * True when the error represents a PERMANENT failure that must never be retried
 * (regardless of which retry layer is asking): a user cancellation, or a
 * permanent HTTP status like 413 where re-sending the same body cannot succeed.
 * Used by BOTH the per-request retry (`executeWithRetry`) and the chat-level
 * "auto Try Again" loop so neither one re-sends an oversized/aborted request.
 */
export function isNonRetryableError(error: unknown, token?: vscode.CancellationToken): boolean {
	if (token?.isCancellationRequested) {
		return true;
	}
	if (error instanceof vscode.CancellationError) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error ?? "");
	return NON_RETRYABLE_STATUS_CODES.some((code) => message.includes(`[${code}]`));
}

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
}

export function getModelProviderId(model: unknown): string {
	if (!model || typeof model !== "object") {
		return "";
	}
	const obj = model as Record<string, unknown>;
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provide) ||
		pick(obj.provider) ||
		pick(obj.ownedBy) ||
		pick(obj.owner) ||
		pick(obj.vendor)
	);
}

export function normalizeUserModels(models: unknown): HFModelItem[] {
	const list = Array.isArray(models) ? models : [];
	const out: HFModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const provider = getModelProviderId(item);
		out.push({ ...(item as HFModelItem), owned_by: provider });
	}
	return out;
}

/**
 * Parse a model ID that may contain a configuration ID separator.
 * Format: "baseId::configId" or just "baseId"
 */
export function parseModelId(modelId: string): ParsedModelId {
	const parts = modelId.split("::");
	if (parts.length >= 2) {
		return {
			baseId: parts[0],
			configId: parts.slice(1).join("::"), // In case configId itself contains '::'
		};
	}
	return {
		baseId: modelId,
	};
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? { type: "object", properties: {} };
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[customcopilot] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

export type OpenAIResponsesToolChoice = "auto" | { type: "function"; name: string };

/**
 * Convert VS Code tool definitions to OpenAI Responses API tool definitions.
 * Responses uses `{ type:"function", name, description, parameters }` (no nested `function` object).
 */
export function convertToolsToOpenAIResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: OpenAIResponsesToolChoice;
} {
	const toolConfig = convertToolsToOpenAI(options);
	if (!toolConfig.tools || toolConfig.tools.length === 0) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = toolConfig.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = {
			type: "function",
			name: t.function.name,
		};
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: OpenAIResponsesToolChoice | undefined;
	if (toolConfig.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (toolConfig.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: toolConfig.tool_choice.function.name };
	}

	return { tools, tool_choice };
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("customcopilot.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Optional cancellation token. When the user presses Stop in VS
 *   Code, the loop aborts immediately instead of continuing to re-send the
 *   request and rotate keys.
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	retryConfig: RetryConfig,
	token?: vscode.CancellationToken
): Promise<T> {
	// If cancellation was already requested before we start, do nothing.
	if (token?.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const baseIntervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		// Stop was pressed between attempts — bail out without re-sending.
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Permanent failures — user cancellation or a permanent HTTP status like
			// 413 (body too large) — must never be retried or key-rotated: re-sending
			// the same payload can never succeed. This check wins over the user's
			// retryable list.
			if (isNonRetryableError(lastError, token)) {
				throw lastError;
			}

			// Check if error is retryable based on status codes
			const isRetryableStatusError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));
			// Check if error is retryable based on network error patterns
			const isRetryableNetworkError = networkErrorPatterns.some((pattern) => lastError?.message.includes(pattern));
			const isRetryableError = isRetryableStatusError || isRetryableNetworkError;

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			// A dead key (quota/auth) with healthy alternatives should rotate
			// immediately — no point waiting out an exponential backoff when the
			// next key is ready to serve. Transient errors still back off.
			const switchKeyNow = (lastError as { retryImmediately?: boolean }).retryImmediately === true;
			// Exponential backoff: interval doubles each attempt, capped at 60s
			const delayMs = switchKeyNow
				? 0
				: Math.min(baseIntervalMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt), RETRY_MAX_INTERVAL_MS);

			logger.warn("retry.attempt", {
				attempt: attempt + 1,
				maxAttempts,
				delayMs,
				errorName: lastError.name,
				errorMessage: lastError.message,
			});

			console.error(
				`[customcopilot] Retryable error detected, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts}). Error:`,
				lastError instanceof Error ? { name: lastError.name, message: lastError.message } : String(lastError)
			);

			// Wait for the calculated interval before retrying, but wake up early
			// (and abort) if the user cancels during the backoff.
			const cancelled = await delayOrCancel(delayMs, token);
			if (cancelled) {
				throw new vscode.CancellationError();
			}
		}
	}

	// This should never be reached, but TypeScript needs it
	logger.error("retry.exhausted", {
		maxAttempts,
		lastError: lastError ? { name: lastError.name, message: lastError.message } : String(lastError),
	});
	throw lastError || new Error("Retry failed");
}

/**
 * Sleep for `delayMs`, resolving early with `true` if the cancellation token
 * fires during the wait. Resolves with `false` on a normal timeout.
 */
export function delayOrCancel(delayMs: number, token?: vscode.CancellationToken): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		if (token?.isCancellationRequested) {
			resolve(true);
			return;
		}
		const timer = setTimeout(() => {
			sub?.dispose();
			resolve(false);
		}, delayMs);
		// `sub` is referenced by the timer callback above, but that callback only
		// runs asynchronously (after this function returns), so a `const` declared
		// here is safely initialised before any access.
		const sub = token?.onCancellationRequested(() => {
			clearTimeout(timer);
			sub?.dispose();
			resolve(true);
		});
	});
}

/**
 * Resolves the proxy URL from model config or global settings, acknowledging bypass keywords.
 * If model proxy is "none", "direct", or "no-proxy", returns undefined to bypass global proxy.
 */
export function resolveProxyUrl(modelProxy?: string, globalProxy?: string): string | undefined {
	if (modelProxy) {
		const trimmed = modelProxy.trim().toLowerCase();
		if (trimmed === "none" || trimmed === "direct" || trimmed === "no-proxy" || trimmed === "no_proxy") {
			return undefined;
		}
		return modelProxy;
	}
	if (globalProxy) {
		const trimmed = globalProxy.trim().toLowerCase();
		if (trimmed === "none" || trimmed === "direct" || trimmed === "no-proxy" || trimmed === "no_proxy") {
			return undefined;
		}
		return globalProxy;
	}
	return undefined;
}
