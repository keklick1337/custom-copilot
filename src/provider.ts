import { createHash } from "crypto";
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { CustomApiMode, CustomModelItem } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import {
	parseModelId,
	resolveUserModelById,
	createRetryConfig,
	executeWithRetry,
	normalizeUserModels,
	resolveProxyUrl,
	isNonRetryableError,
	delayOrCancel,
	parseRetryAfterMs,
	modelNeedsReasoningEcho,
	safeUrlHost,
	withProviderDefaults,
	isToolResultPart,
} from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { applyModelConfiguration } from "./modelConfig";
import { DEFAULT_IMAGE_MAX_DIMENSION, shrinkMessageImages } from "./imageResize";

/** Per-model `image_max_dimension` wins over the global setting; 0 disables resizing. */
function resolveImageMaxDimension(um: CustomModelItem, config: vscode.WorkspaceConfiguration): number {
	const own = um.image_max_dimension;
	if (typeof own === "number" && own >= 0) {
		return Math.floor(own);
	}
	const global = config.get<number>("customcopilot.imageMaxDimension", DEFAULT_IMAGE_MAX_DIMENSION);
	return typeof global === "number" && global >= 0 ? Math.floor(global) : DEFAULT_IMAGE_MAX_DIMENSION;
}
import { countMessageTokens, reportLearnedImageTokenCost } from "./provideToken";

/**
 * Z.AI / BigModel business codes that are terminal for the key (plan caps,
 * expiry, no model access, fair-use) — ZCode `failure-provider-business-codes.ts`.
 * Matched as a quoted or bracketed code so unrelated numbers don't trigger.
 */
const ZAI_TERMINAL_QUOTA_RE = /["[](?:1304|1308|1309|1310|1311|1313)["\]]|"code"\s*:\s*(?:1304|1308|1309|1310|1311|1313)\b/;

/** Retryable failures reported inside a 200 stream (ZCode business-code + network classes). */
const TRANSIENT_STREAM_ERROR_RE =
	/\[(?:1302|1303|1305|1312|1234|1230|1120|500|502|503|529)\]|\b(?:network_error(?:_retryable)?|internal network error|overloaded(?:_error)?|temporarily overloaded|api_error)\b/i;

/** `retry-after-ms` header (OpenAI/Anthropic SDK convention) → ms. */
function msHeader(value: string | null): number | undefined {
	const n = value ? Number(value.trim()) : NaN;
	return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** Remove thinking / redacted_thinking blocks from an Anthropic request body; true if any were removed. */
function stripReplayedThinking(body: unknown): boolean {
	const messages = (body as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(messages)) {
		return false;
	}
	let removed = false;
	for (const msg of messages as Array<{ content?: unknown }>) {
		if (!Array.isArray(msg.content)) {
			continue;
		}
		const kept = (msg.content as Array<{ type?: string }>).filter(
			(b) => b?.type !== "thinking" && b?.type !== "redacted_thinking"
		);
		if (kept.length !== msg.content.length) {
			removed = true;
			msg.content = kept.length > 0 ? kept : [{ type: "text", text: "(thinking omitted)" }];
		}
	}
	return removed;
}

/** Previous request's real prompt_tokens + shape (anchor for image-cost calibration). */
let lastPromptAnchor: { promptTokens: number; images: number; messages: number; textChars: number } | undefined;

function countImages(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	return msgs.reduce(
		(sum, m) =>
			sum +
			(m.content ?? []).filter((p) => p instanceof vscode.LanguageModelDataPart && p.mimeType.startsWith("image/")).length,
		0
	);
}

function countTextChars(msgs: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let chars = 0;
	for (const m of msgs) {
		for (const p of m.content ?? []) {
			if (p instanceof vscode.LanguageModelTextPart) {
				chars += p.value.length;
			}
		}
	}
	return chars;
}

/**
 * Learn the per-image token price from provider-reported prompt_tokens.
 * Only fires when this request is the direct continuation of the anchor
 * (same conversation, a couple of messages more) AND it introduced new
 * images: the residual minus the estimated cost of the new text is then
 * attributable to those images alone. Unrelated conversations never mix.
 */
function calibrateImageTokenCost(
	realPromptTokens: number,
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): void {
	try {
		const images = countImages(messages);
		const textChars = countTextChars(messages);
		const anchor = lastPromptAnchor;
		lastPromptAnchor = { promptTokens: realPromptTokens, images, messages: messages.length, textChars };
		if (!anchor) {
			return;
		}
		const newImages = images - anchor.images;
		const newMessages = messages.length - anchor.messages;
		if (newImages <= 0 || newMessages <= 0 || newMessages > 3 || textChars < anchor.textChars) {
			return;
		}
		const textDeltaTokens = Math.ceil((textChars - anchor.textChars) / 4);
		const residual = realPromptTokens - anchor.promptTokens - textDeltaTokens;
		if (residual <= 0) {
			return;
		}
		reportLearnedImageTokenCost(residual / newImages);
	} catch {
		// calibration is best-effort
	}
}
import { updateContextStatusBar } from "./statusBar";
import { notifyChatRequestStart } from "./chatActivity";
import { keyBalancer, parseApiKeys } from "./keyBalancer";
import { resolveApiKeysFromSource } from "./apiKeySource";
import { OllamaApi, probeOllamaModel } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import {
	GeminiApi,
	buildGeminiGenerateContentUrl,
	mergeGeminiAlternating,
	type GeminiToolCallMeta,
} from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi, type ApiUsage, type MessageConversionConfig } from "./commonApi";
import { logger } from "./logger";
import { buildFetchNetworkInit, proxyFetch } from "./network";
import { applyPromptOverride } from "./promptOverride";

/**
 * VS Code Chat provider backed by user-configured custom model endpoints.
 */
export class CustomEndpointChatProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();
	private readonly _openaiResponsesPreviousResponseIdUnsupportedBaseUrls = new Set<string>();
	private readonly _streamOptionsUnsupportedBaseUrls = new Set<string>();

	/**
	 * Fired whenever the user's model configuration (`customcopilot.models`)
	 * changes.  VS Code listens to this event per-vendor and immediately
	 * re-resolves `provideLanguageModelChatInformation` — the model picker
	 * updates live, without a window reload or restart.
	 *
	 * All provider instances share one global emitter: a model added under
	 * any apiMode re-triggers a resolve for every vendor (VS Code diffs the
	 * metadata, so vendors whose lists didn't change fire no UI update).
	 */
	private static readonly _onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = CustomEndpointChatProvider._onDidChangeEmitter.event;

	/** Fire the change event for all registered vendors. */
	public static notifyModelsChanged(): void {
		CustomEndpointChatProvider._onDidChangeEmitter.fire();
	}

	static readonly OPENAI_RESPONSES_STATEFUL_MARKER_MIME = "application/vnd.customcopilot.stateful-marker";

	/**
	 * Create a provider using the given secret storage for the API key.
	 * @param secrets VS Code secret storage.
	 * @param statusBarItem Status bar item used to surface token usage.
	 * @param vendorApiMode When set, this provider instance only lists models whose
	 * effective `apiMode` matches, so each registered vendor renders as a separate
	 * group in the model picker (mirrors how Copilot BYOK shows OpenAI/Anthropic/…).
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly statusBarItem: vscode.StatusBarItem,
		private readonly vendorApiMode?: CustomApiMode
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean; configuration?: Record<string, unknown> },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		// When the vendor declares a `configuration` schema (in package.json),
		// VS Code calls this method twice: once without `configuration` (the
		// initial groupless load that populates the model cache) and once per
		// configured group with `configuration` set.  Our models are managed
		// entirely through the extension's webview config UI, not through VS
		// Code's group/config system, so group-specific calls must return an
		// empty list to avoid duplicate model entries (which would get
		// group-namespaced identifiers like vendor/groupName/modelId).
		//
		// The empty return is harmless: the group entry is still recorded in
		// `chatLanguageModels.json`, which is what makes `hasByokModels` true
		// — letting signed-out users chat with BYOK models without "Sign in to
		// use Copilot".
		if (options.configuration) {
			return [];
		}
		return prepareLanguageModelChatInformation(
			{ silent: options.silent ?? false, apiMode: this.vendorApiMode },
			_token,
			this.secrets
		);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		// Match the model's actual replay setting — reasoning tokens only
		// count against the context when they are actually re-sent.
		const userModels = normalizeUserModels(
			vscode.workspace.getConfiguration().get<unknown>("customcopilot.models", [])
		);
		const um = resolveUserModelById(model.id, userModels, this.vendorApiMode);
		return countMessageTokens(text, {
			includeReasoningInRequest: modelNeedsReasoningEcho(um ? withProviderDefaults(um, userModels) : um),
		});
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		// Signal that VS Code has dispatched a request to us. By the time this provider is
		// invoked the request is already registered on the chat session model, so the Chat
		// Generator can safely move on to the next session without losing this one.
		notifyChatRequestStart();
		let hasReported = false;
		const trackingProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				hasReported = true;
				try {
					progress.report(part);
				} catch (e) {
					console.error("[customcopilot] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};

		// Chat-level automatic retry ("auto Try Again"): when a request fails before any
		// content has been streamed, transparently re-run the whole generation so the user
		// does not have to click "Try Again". Controlled by `customcopilot.chatRetries`
		// (-1 = infinite, 0 = disabled, N = up to N extra attempts) and
		// `customcopilot.chatRetryInterval` (ms between attempts). Retries only happen while
		// nothing has been emitted yet, so already-streamed output is never duplicated.
		const retrySettings = vscode.workspace.getConfiguration();
		const chatRetries = Math.trunc(retrySettings.get<number>("customcopilot.chatRetries", 0));
		const chatRetryIntervalMs = Math.max(0, retrySettings.get<number>("customcopilot.chatRetryInterval", 1000));
		const chatRetryJitterMs = Math.max(0, retrySettings.get<number>("customcopilot.chatRetryJitter", 0));
		let chatAttempt = 0;
		for (;;) {
			// Bail out before (re)starting if the user already pressed Stop.
			if (token.isCancellationRequested) {
				return;
			}
			try {
				await this.runChatResponse(model, messages, options, trackingProgress, token);
				return;
			} catch (err) {
				// Never retry when: the user cancelled, the error is permanent for this
				// payload (e.g. 413 Request Entity Too Large — re-sending the same body
				// can never succeed), something was already streamed, or attempts are
				// exhausted. This loop is independent from `executeWithRetry`, so it must
				// apply the same non-retryable rules or a 413 would loop here forever.
				const canRetry = chatRetries < 0 || chatAttempt < chatRetries;
				if (
					token.isCancellationRequested ||
					isNonRetryableError(err, token) ||
					hasReported ||
					!canRetry
				) {
					throw err;
				}
				chatAttempt++;
				const jitterMs = chatRetryJitterMs > 0 ? Math.floor(Math.random() * (chatRetryJitterMs + 1)) : 0;
				const delayMs = chatRetryIntervalMs + jitterMs;
				logger.warn("chat.retry", {
					modelId: model.id,
					attempt: chatAttempt,
					maxAttempts: chatRetries < 0 ? "infinite" : chatRetries,
					delayMs,
					errorMessage: err instanceof Error ? err.message : String(err),
				});
				// Cancellable wait: if Stop is pressed during the backoff, abort the
				// loop instead of firing another request.
				if (delayMs > 0) {
					const cancelled = await delayOrCancel(delayMs, token);
					if (cancelled) {
						return;
					}
				}
			}
		}
	}

	/**
	 * Performs a single chat-response attempt: resolves the model configuration, builds the
	 * request, and streams the result to {@link trackingProgress}. Wrapped by
	 * {@link provideLanguageModelChatResponse} for chat-level automatic retries.
	 */
	private async runChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		trackingProgress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const requestStartTime = Date.now();
		// Declared here so the `finally` block can always dispose it. Set once the
		// request's AbortController is wired to the cancellation token below.
		let cancelSub: vscode.Disposable | undefined;
		try {
			// Rewrite the system prompt that Copilot Chat assembled, per the user's
			// customcopilot.promptOverride.* settings (no-op when disabled). This is
			// the single chokepoint before any adapter converts the messages. It also
			// captures the original system prompt so it can be viewed/reused in the UI.
			messages = applyPromptOverride(messages, model.id);

			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

			// Parse model ID to handle config ID
			const parsedModelId = parseModelId(model.id);

			// Find matching user model configuration.
			//
			// Resolve the exact config entry behind this (possibly prefixed) id.
			const um: CustomModelItem | undefined = resolveUserModelById(model.id, userModels, this.vendorApiMode);

			// If still no model found, the configuration changed between the model
			// listing and this request (model deleted/reordered). Fail fast with
			// an actionable error instead of a lenient fallback that could silently
			// send the request to a DIFFERENT endpoint/key pool sharing the base id.
			if (!um) {
				throw new Error(
					`Model configuration for "${parsedModelId.baseId}" was not found. It may have been removed or renamed — please re-select the model.`
				);
			}

			// Check if using Ollama native API mode
			// Provider-level settings (apiMode/baseUrl/...) are stored per-model,
			// including on a hidden `__provider__<id>` placeholder. A model added
			// via the model form may not carry them, so fall back to a sibling
			// model of the same provider.
			const providerSibling = um?.owned_by
				? userModels.find((m) => m.id !== um!.id && m.owned_by === um!.owned_by && !!m.baseUrl)
				: undefined;
			const apiMode = um?.apiMode ?? providerSibling?.apiMode ?? "openai";
			// Resolve the base URL from the selected model. If the selected model
			// has no baseUrl of its own, fall back to a sibling model of the same
			// provider that does.
			let baseUrl = um?.baseUrl || "";
			if (!baseUrl && um?.owned_by) {
				baseUrl = providerSibling?.baseUrl || "";
			}

			logger.info("request.start", {
				modelId: model.id,
				messageCount: messages.length,
				apiMode,
				baseUrl,
			});

			// Prepare model configuration
			// Reasoning echo: explicit `include_reasoning_in_request` wins;
			// otherwise auto-on only for providers that REQUIRE it
			// (DeepSeek/Kimi/MiMo — hermes reasoning-echo policy).
			// Effective config (provider-level baseUrl/apiMode filled in) for
			// everything that inspects the endpoint host.
			const umEff: CustomModelItem = applyModelConfiguration(
				{ ...withProviderDefaults(um, userModels), baseUrl, apiMode },
				options.modelConfiguration
			);
			if (options.modelConfiguration) {
				logger.debug("request.modelConfiguration", { ...options.modelConfiguration });
			}
			messages = shrinkMessageImages(messages, resolveImageMaxDimension(umEff, config));
			const requestHost = safeUrlHost(baseUrl);
			const modelConfig: MessageConversionConfig = {
				includeReasoningInRequest: modelNeedsReasoningEcho(umEff),
				replayReasoningDetails: requestHost === "openrouter.ai" || requestHost.endsWith(".openrouter.ai"),
				nativeAnthropic: requestHost === "api.anthropic.com" || requestHost.endsWith(".anthropic.com"),
			};

			// Update Token Usage
			updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig, this.vendorApiMode);

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("customcopilot.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					logger.debug("request.delay", {
						delayMs,
						elapsed,
						remainingDelay,
					});
					// Cancellable: pressing Stop during the pacing delay must not
					// still fire the request afterwards.
					if (await delayOrCancel(remainingDelay, token)) {
						throw new vscode.CancellationError();
					}
				}
			}

			// Get API key(s) for the model's provider. Multiple keys (stored
			// newline-separated under the same secret) are load-balanced per request.
			const provider = um?.owned_by;
			const normalizedProvider = (provider ?? "").trim().toLowerCase();
			const keySourceProxyUrl = resolveProxyUrl(umEff.proxyUrl, config.get<string>("customcopilot.proxyUrl", "").trim());
			const apiKeys = await this.resolveApiKeys(provider, keySourceProxyUrl);
			if (apiKeys.length === 0) {
				logger.warn("apiKey.missing", {
					provider: provider ?? "",
				});
				throw new Error("API key not configured");
			}

			// send chat request
			const BASE_URL = baseUrl;
			let parsedBaseUrl: URL;
			try {
				parsedBaseUrl = new URL(BASE_URL);
			} catch {
				parsedBaseUrl = null as unknown as URL;
			}
			if (!parsedBaseUrl || (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:")) {
				throw new Error(`Invalid base URL configuration: "${BASE_URL}"`);
			}

			// get retry config
			const retryConfig = createRetryConfig();
			// With multiple keys, allow enough retry attempts to cycle through the
			// pool and also rotate on auth failures (a bad/limited key should be
			// benched and another tried instead of surfacing the error).
			if (apiKeys.length > 1) {
				retryConfig.max_attempts = Math.max(retryConfig.max_attempts ?? 3, apiKeys.length + 1);
				retryConfig.status_codes = [...new Set([...(retryConfig.status_codes ?? []), 401, 402, 403, 408, 409])];
			}
			const proxyUrl = resolveProxyUrl(umEff.proxyUrl, config.get<string>("customcopilot.proxyUrl", "").trim());
			const requestNetworkInit = buildFetchNetworkInit(proxyUrl);

			// Abort the in-flight HTTP request the moment the user presses Stop in VS
			// Code. Without this, a large body (e.g. a 1.8MB request that the server
			// rejects with 413) keeps uploading and the retry loop keeps re-sending
			// it. Wiring the token to an AbortController and attaching its signal to
			// every fetch (all sites spread `...requestNetworkInit`) cuts the request
			// off immediately. `executeWithRetry` separately stops looping on cancel.
			const abortController = new AbortController();
			cancelSub = token.onCancellationRequested(() => abortController.abort());
			if (token.isCancellationRequested) {
				abortController.abort();
			}
			(requestNetworkInit as RequestInit).signal = abortController.signal;

			// Per-attempt header builder: picks the healthiest key from the balancer
			// each time it is called so executeWithRetry rotates keys across attempts.
			// `triedKeys` makes each retry prefer a key not yet used in this request,
			// so a failing key is skipped instead of being hit again.
			let lastSelectedKey = "";
			const triedKeys = new Set<string>();
			const selectRequestHeaders = () => {
				lastSelectedKey = keyBalancer.selectKey(normalizedProvider, apiKeys, triedKeys);
				if (lastSelectedKey) {
					triedKeys.add(lastSelectedKey);
					keyBalancer.recordRequest(normalizedProvider, lastSelectedKey);
				}
				// Adapter-specific headers (e.g. anthropic-beta) first, so the
				// user's custom headers can still override them.
				const adapterHeaders = (activeAdapter as { requestHeaders?: Record<string, string> } | undefined)
					?.requestHeaders;
				return CommonApi.prepareHeaders(
					lastSelectedKey,
					apiMode,
					{ ...(adapterHeaders ?? {}), ...(um?.headers ?? {}) },
					umEff.userAgent
				);
			};
			// A "fatal" key error means this specific key cannot be used (quota
			// exhausted, invalid/disabled key, forbidden). Such a key is benched
			// hard so the balancer immediately rotates to another one.
			const isFatalKeyError = (status: number, body: string): boolean => {
				// 402 Payment Required = this key's billing is exhausted (hermes _V_BILLING).
				if (status === 401 || status === 402 || status === 403) {
					return true;
				}
				if (status === 429) {
					// Overload 429s (Z.AI 1305 "temporarily overloaded", "overloaded")
					// are NOT the key's fault — back off on the same key instead.
					if (/\b1305\b|temporarily overloaded|overloaded_error/i.test(body)) {
						return false;
					}
					if (ZAI_TERMINAL_QUOTA_RE.test(body)) {
						return true;
					}
					// Z.AI 1113 / 余额不足 = the key's balance is exhausted.
					return /insufficient_quota|invalid_api_key|billing|access_terminated|account_deactivated|exceeded your current quota|"1113"|\b1113\b|insufficient balance|余额不足|insufficient credits|payment required|out of funds|budget limit exceeded|credit balance/i.test(
						body
					);
				}
				return false;
			};
			// Records the failure against the current key and returns an Error to
			// throw. When the key is dead (fatal) and other keys exist, the error is
			// flagged `retryImmediately` so executeWithRetry rotates without backoff.
			const handleKeyError = (
				status: number,
				statusText: string,
				body: string,
				message: string,
				retryAfterMs?: number
			): Error => {
				const fatal = isFatalKeyError(status, body);
				// Z.AI plan caps (1304 daily, 1308 usage, 1309 plan expired, 1310
				// weekly/monthly, 1311 model not in plan, 1313 fair use) are
				// terminal for THIS key: rotate if another key exists, otherwise
				// fail fast instead of backing off (ZCode business-code policy).
				const terminalQuota = ZAI_TERMINAL_QUOTA_RE.test(body);
				keyBalancer.reportError(normalizedProvider, lastSelectedKey, {
					fatal,
					message: `[${status}] ${statusText}`,
				});
				const err = new Error(message) as Error & {
					status?: number;
					errorText?: string;
					retryImmediately?: boolean;
					retryAfterMs?: number;
				};
				err.status = status;
				err.errorText = body;
				if (retryAfterMs !== undefined) {
					err.retryAfterMs = retryAfterMs;
				}
				if (fatal && apiKeys.length > 1) {
					err.retryImmediately = true;
				} else if (terminalQuota) {
					(err as { nonRetryable?: boolean }).nonRetryable = true;
				}
				return err;
			};
			logger.debug("request.headers", {
				keyPoolSize: apiKeys.length,
			});
			// Privacy gate: full conversation dumps go to the log file ONLY when
			// the user explicitly opted in via `customcopilot.logMessageContent`.
			// Plain `debug` level alone must not persist chat history (user code,
			// file contents) to disk in plaintext.
			if (config.get<boolean>("customcopilot.logMessageContent", false)) {
				logger.debug("request.messages.origin", {
					messages: messages,
				});
			}
			// Shared dispatcher: one fetch/retry/error path for every apiMode.
			// Each adapter contributes only its URL, request body and stream
			// processor — the retry/key-rotation/error formatting logic exists once.
			// The adapter whose stream is being processed (set by each apiMode
			// branch) — read after streaming to report token usage.
			let activeAdapter: CommonApi<unknown, unknown> | undefined;

			// Count real content parts streamed by the adapter (usage/marker
			// data parts excluded) for the empty-response guard.
			let contentPartCount = 0;
			const outerProgress = trackingProgress;
			trackingProgress = {
				report: (part) => {
					if (
						(part instanceof vscode.LanguageModelTextPart && part.value.trim().length > 0) ||
						part instanceof vscode.LanguageModelToolCallPart ||
						(part instanceof vscode.LanguageModelThinkingPart &&
							(Array.isArray(part.value) ? part.value.join("") : part.value).length > 0)
					) {
						contentPartCount++;
					}
					outerProgress.report(part);
				},
			};

			let transientStreamRetried = false;
			const sendWithRetry = async (
				url: string,
				body: unknown,
				errorLabel: string,
				processStream: (responseBody: ReadableStream<Uint8Array>) => Promise<void>
			): Promise<void> => {
				const usageAdapter = activeAdapter as { _lastUsage?: ApiUsage } | undefined;
				logger.debug("request.body", { url, requestBody: body });
				let strippedThinking = false;
				const response = await executeWithRetry(async () => {
					let res = await proxyFetch(url, {
						...requestNetworkInit,
						method: "POST",
						headers: selectRequestHeaders(),
						body: JSON.stringify(body),
					});

					// Anthropic binds signed thinking to the system/tools prefix it was
					// created under; Copilot changes both mid-conversation. Drop replayed
					// thinking blocks once and resend instead of failing the turn.
					if (res.status === 400 && !strippedThinking) {
						const errorText = await res.clone().text();
						if (/signature.{0,40}thinking|thinking.{0,40}signature|bound to a different conversation/i.test(errorText)) {
							strippedThinking = stripReplayedThinking(body);
							if (strippedThinking) {
								logger.warn("request.thinking.stripped", { model: model.id });
								res = await proxyFetch(url, {
									...requestNetworkInit,
									method: "POST",
									headers: selectRequestHeaders(),
									body: JSON.stringify(body),
								});
							}
						}
					}

					if (!res.ok) {
						const errorText = await res.text();
						console.error(`[customcopilot] ${errorLabel} error response`, errorText);
						// Anthropic fast mode has its own rate limit / capacity:
						// on 429/529 drop `speed` and retry at standard speed
						// right away (the body is re-serialized per attempt).
						const fastBody = body as { speed?: string } | null;
						if ((res.status === 429 || res.status === 529) && fastBody && fastBody.speed === "fast") {
							delete fastBody.speed;
							logger.warn("request.fastMode.fallback", { status: res.status, model: model.id });
							const fallbackErr = new Error(
								`${errorLabel}: fast mode unavailable [${res.status}], retrying at standard speed`
							) as Error & { status?: number; retryImmediately?: boolean };
							fallbackErr.status = res.status;
							fallbackErr.retryImmediately = true;
							throw fallbackErr;
						}
						throw handleKeyError(
							res.status,
							res.statusText,
							errorText,
							`${errorLabel}: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`,
							res.headers.get("x-should-retry") === "false"
								? undefined
								: (msHeader(res.headers.get("retry-after-ms")) ?? parseRetryAfterMs(res.headers.get("retry-after")))
						);
					}

					keyBalancer.reportSuccess(normalizedProvider, lastSelectedKey);
					return res;
				}, retryConfig, token);

				if (!response.body) {
					throw new Error(`No response body from ${errorLabel}`);
				}
				const contentPartsBefore = contentPartCount;
				try {
					await processStream(response.body);
				} catch (streamErr) {
					// Transient business error inside an HTTP 200 stream (Z.AI 1302/1303/1305/1312/1234,
					// network_error, overloaded) before anything was shown: resend once.
					const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
					if (
						contentPartCount === contentPartsBefore &&
						!token.isCancellationRequested &&
						!transientStreamRetried &&
						TRANSIENT_STREAM_ERROR_RE.test(msg)
					) {
						transientStreamRetried = true;
						logger.warn("request.stream.transientRetry", { model: model.id, error: msg.slice(0, 300) });
						await delayOrCancel(1500 + Math.floor(Math.random() * 1500), token);
						return sendWithRetry(url, body, errorLabel, processStream);
					}
					throw streamErr;
				}

				// Empty-response guard (hermes `empty_response_guard`): a
				// stream that completed without a single text/thinking/tool
				// part is an upstream failure, not an answer. Throwing lets the
				// chat-level auto-retry kick in and otherwise shows an error
				// instead of a blank reply.
				// Exception: right after tool results an empty end_turn/STOP is
				// a legitimate "nothing more to add" (Claude, Gemini).
				const lastMessage = messages[messages.length - 1];
				const answersToolResults = (lastMessage?.content ?? []).some((p) => isToolResultPart(p));
				if (contentPartCount === contentPartsBefore && !answersToolResults && !token.isCancellationRequested) {
					throw new Error(`${errorLabel}: the model returned an empty response.`);
				}

				// Report token usage as a LanguageModelDataPart with the
				// "usage" mime type — the same internal contract Copilot's own
				// BYOK providers use. Copilot Chat's context-usage circle
				// (and token counting) keys off this part; without it the
				// circle never populates for custom models. Emitted AFTER the
				// stream completes so the numbers are final.
				const usage = usageAdapter?._lastUsage;
				if (usage && (usage.prompt_tokens > 0 || usage.completion_tokens > 0)) {
					trackingProgress.report(
						new vscode.LanguageModelDataPart(
							new TextEncoder().encode(JSON.stringify(usage)),
							"usage"
						)
					);
					// Calibrate the per-image token cost from the provider's
					// own accounting (hermes-agent pattern): with a fresh
					// anchor, the residual between this real prompt_tokens and
					// anchor + locally-estimated text delta is the price of
					// the images this request introduced.
					calibrateImageTokenCost(usage.prompt_tokens, messages);
				}
				};

			const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
			if (apiMode === "ollama") {
				// Ollama native API mode
				const ollamaApi = new OllamaApi(model.id);
				activeAdapter = ollamaApi as unknown as CommonApi<unknown, unknown>;
				let ollamaRequestBody: OllamaRequestBody = {
					model: parsedModelId.baseId,
					messages: ollamaApi.convertMessages(messages, modelConfig),
					stream: true,
				};
				ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, umEff, options);
				// Ask the server for the model's real window / capabilities (cached).
				const ollamaInfo = await probeOllamaModel(
					normalizedBaseUrl,
					parsedModelId.baseId,
					CommonApi.prepareHeaders(apiKeys[0], "ollama", umEff.headers, umEff.userAgent),
					requestNetworkInit
				);
				if (ollamaInfo?.contextLength && ollamaRequestBody.options?.num_ctx === undefined) {
					// Without num_ctx Ollama uses its small default and silently
					// truncates the prompt. Capped at the window advertised to
					// Copilot (128K default) so a huge GGUF max can't blow up the
					// KV-cache allocation.
					ollamaRequestBody.options = {
						...(ollamaRequestBody.options ?? {}),
						num_ctx: Math.min(ollamaInfo.contextLength, umEff.context_length ?? 128000),
					};
				}
				if (ollamaInfo?.capabilities && !ollamaInfo.capabilities.includes("thinking") && ollamaRequestBody.think) {
					// `think` on a non-thinking model is a 400 (hermes gates on /api/show).
					delete ollamaRequestBody.think;
				}
				await sendWithRetry(
					`${normalizedBaseUrl}/api/chat`,
				ollamaRequestBody,
				"Ollama API",
				(body) => ollamaApi.processStreamingResponse(body, trackingProgress, token)
				);
			} else if (apiMode === "anthropic" || apiMode === "zai") {
				// Anthropic API mode (also used for Z.AI which is Anthropic-compatible with Bearer auth).
				// Some providers configure the baseUrl with a version suffix (e.g. .../v1) —
				// avoid double-appending (.../v1/v1/messages).
				const anthropicApi = new AnthropicApi(model.id);
				activeAdapter = anthropicApi as unknown as CommonApi<unknown, unknown>;
				let requestBody: AnthropicRequestBody = {
					model: parsedModelId.baseId,
					messages: anthropicApi.convertMessages(messages, modelConfig),
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, umEff, options);
				const url = normalizedBaseUrl.endsWith("/v1")
					? `${normalizedBaseUrl}/messages`
					: `${normalizedBaseUrl}/v1/messages`;
				await sendWithRetry(url, requestBody, "Anthropic API", (body) =>
					anthropicApi.processStreamingResponse(body, trackingProgress, token)
				);
			} else if (apiMode === "openai-responses") {
				// OpenAI Responses API mode (stateful via previous_response_id markers)
				const openaiResponsesApi = new OpenaiResponsesApi(model.id);
				activeAdapter = openaiResponsesApi as unknown as CommonApi<unknown, unknown>;
				const statefulModelId = parsedModelId.baseId;

				// Convert the delta FIRST, the full history LAST: every
				// convertMessages call resets adapter state, and the final call
				// must be the one that captured the system prompt — otherwise
				// `instructions` vanished on every turn after the first.
				const marker = findLastOpenAIResponsesStatefulMarker(statefulModelId, messages);
				let deltaInput: unknown[] | null = null;
				if (marker && marker.index >= 0 && marker.index < messages.length - 1) {
					const converted = openaiResponsesApi.convertMessages(messages.slice(marker.index + 1), modelConfig);
					if (converted.length > 0) {
						deltaInput = converted;
					}
				}
				const fullInput = openaiResponsesApi.convertMessages(messages, modelConfig);

				const canUsePreviousResponseId =
					!!marker?.marker &&
					!this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.has(normalizedBaseUrl) &&
					Array.isArray(deltaInput) &&
					deltaInput.length > 0;

				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					input: canUsePreviousResponseId ? deltaInput! : fullInput,
					stream: true,
				};
				requestBody = openaiResponsesApi.prepareRequestBody(requestBody, umEff, options);

				// Add prompt_cache_key to enable OpenAI prompt caching.
				// Without this parameter, cached_tokens is always 0 even with identical requests.
				// OpenAI caps the key at 64 chars (hermes bounds it the same way).
				if (!requestBody.prompt_cache_key) {
					const cacheKey = `customcopilot-${parsedModelId.baseId}`;
					requestBody.prompt_cache_key =
						cacheKey.length <= 64 ? cacheKey : `pck_${createHash("sha256").update(cacheKey).digest("hex").slice(0, 24)}`;
				}

				// If the user explicitly set `previous_response_id` via `extra`, don't apply stateful slicing.
				let addedPreviousResponseId = false;
				if (requestBody.previous_response_id !== undefined) {
					requestBody.input = fullInput;
				} else if (canUsePreviousResponseId) {
					requestBody.previous_response_id = marker!.marker;
					addedPreviousResponseId = true;
				}

				const processResponsesStream = async (responseBody: ReadableStream<Uint8Array>): Promise<void> => {
					await openaiResponsesApi.processStreamingResponse(responseBody, trackingProgress, token);
					// Append a stateful marker so future requests can reuse `previous_response_id`.
					const responseId = openaiResponsesApi.responseId;
					if (responseId) {
						trackingProgress.report(createOpenAIResponsesStatefulMarkerPart(statefulModelId, responseId));
					}
				};

				const url = `${normalizedBaseUrl}/responses`;
				const errorText = (err: unknown): string => String((err as { errorText?: unknown })?.errorText ?? "");
				const errorStatus = (err: unknown): number | undefined => {
					const status = (err as { status?: unknown })?.status;
					return typeof status === "number" ? status : undefined;
				};
				// Encrypted reasoning is bound to the org/key that issued it: with
				// a multi-key pool (or after a key change) replay fails with
				// invalid_encrypted_content. Retry once without the replayed
				// reasoning items (hermes error_classifier).
				const sendResponses = async (body: Record<string, unknown>): Promise<void> => {
					try {
						await sendWithRetry(url, body, "Responses API", processResponsesStream);
					} catch (err) {
						const hasReasoning =
							Array.isArray(body.input) && body.input.some((i) => (i as { type?: unknown }).type === "reasoning");
						if (
							errorStatus(err) === 400 &&
							hasReasoning &&
							/invalid_encrypted_content|could not be verified|could not decrypt|not issued to this/i.test(errorText(err))
						) {
							logger.warn("responses.encrypted_reasoning.rejected", { modelId: model.id });
							const stripped: Record<string, unknown> = {
								...body,
								input: (body.input as unknown[]).filter((i) => (i as { type?: unknown }).type !== "reasoning"),
							};
							delete stripped.include;
							await sendWithRetry(url, stripped, "Responses API", processResponsesStream);
							return;
						}
						throw err;
					}
				};

				try {
					await sendResponses(requestBody);
				} catch (err) {
					// Some Responses-compatible gateways don't support
					// `previous_response_id`: fall back to the full history — but
					// only for errors that are actually about it (an auth error,
					// 413 or context overflow must not disable stateful mode).
					const status = errorStatus(err);
					const shouldFallback =
						addedPreviousResponseId &&
						status !== undefined &&
						status >= 400 &&
						status < 500 &&
						![401, 403, 413, 429].includes(status) &&
						/previous_response|previous response|not found|unsupported|unknown parameter|unrecognized/i.test(errorText(err));
					if (!shouldFallback) {
						throw err;
					}

					this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.add(normalizedBaseUrl);

					const fallbackBody: Record<string, unknown> = { ...requestBody, input: fullInput };
					delete fallbackBody.previous_response_id;
					await sendResponses(fallbackBody);
				}
			} else if (apiMode === "gemini") {
				// Gemini native API mode
				const geminiApi = new GeminiApi(model.id, this._geminiToolCallMetaByCallId);
				activeAdapter = geminiApi as unknown as CommonApi<unknown, unknown>;
				const geminiMessages = geminiApi.convertMessages(messages, modelConfig);

				const systemParts: string[] = [];
				const contents: GeminiGenerateContentRequest["contents"] = [];
				for (const msg of geminiMessages) {
					if (msg.role === "system") {
						const text = msg.parts
							.map((p) =>
								p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
									? String((p as { text: string }).text)
									: ""
							)
							.join("")
							.trim();
					if (text) {
							systemParts.push(text);
						}
						continue;
					}
					contents.push({ role: msg.role, parts: msg.parts });
				}

				let requestBody: GeminiGenerateContentRequest = { contents: mergeGeminiAlternating(contents) };
				if (systemParts.length > 0) {
					requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
				}
				requestBody = geminiApi.prepareRequestBody(requestBody, umEff, options);

				const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
				if (!url) {
					throw new Error("Invalid Gemini base URL configuration.");
				}
				await sendWithRetry(url, requestBody, "Gemini API", (body) =>
					geminiApi.processStreamingResponse(body, trackingProgress, token)
				);
			} else {
				// OpenAI compatible API mode (default)
				const openaiApi = new OpenaiApi(model.id);
				activeAdapter = openaiApi as unknown as CommonApi<unknown, unknown>;
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					messages: openaiApi.convertMessages(messages, modelConfig),
					stream: true,
					stream_options: { include_usage: true },
				};
				requestBody = openaiApi.prepareRequestBody(requestBody, umEff, options);
				const chatUrl = `${normalizedBaseUrl}/chat/completions`;
				// Remembered per endpoint (hermes latches it per session) so
				// later turns don't pay a 400 round-trip each time.
				if (this._streamOptionsUnsupportedBaseUrls.has(normalizedBaseUrl)) {
					delete requestBody.stream_options;
				}
				const processChatStream = (body: ReadableStream<Uint8Array>) =>
					openaiApi.processStreamingResponse(body, trackingProgress, token);
				try {
					await sendWithRetry(chatUrl, requestBody, "API", processChatStream);
				} catch (err) {
					// Some OpenAI-compatible servers reject `stream_options`
					// (hermes `_rejects_stream_options`): retry once without it.
					const status = (err as { status?: unknown }).status;
					const errorText = String((err as { errorText?: unknown }).errorText ?? "");
					const rejectsStreamOptions =
						(status === 400 || status === 422) &&
						/stream_options/i.test(errorText) &&
						/extra|not supported|unrecognized|unexpected|unknown|not permitted|invalid/i.test(errorText);
					if (!rejectsStreamOptions || requestBody.stream_options === undefined) {
						throw err;
					}
					logger.warn("request.stream_options.unsupported", { modelId: model.id });
					this._streamOptionsUnsupportedBaseUrls.add(normalizedBaseUrl);
					delete requestBody.stream_options;
					await sendWithRetry(chatUrl, requestBody, "API", processChatStream);
				}
		}
		} catch (err) {
			console.error("[customcopilot] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			logger.error("request.error", {
				modelId: model.id,
				messageCount: messages.length,
				errorName: err instanceof Error ? err.name : String(err),
				errorMessage: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			const durationMs = Date.now() - requestStartTime;
			logger.info("request.end", { modelId: model.id, durationMs });
			// Update last request time after successful completion
			this._lastRequestTime = Date.now();
			// Stop listening for cancellation; the request is done.
			cancelSub?.dispose();
		}
	}

	/**
	 * Resolve the pool of API keys for a provider. Keys come either from an inline
	 * secret (multiple keys stored newline-separated under the same per-provider
	 * secret; a single key yields a one-element pool) or, when a remote key source
	 * is configured for the provider, from that URL/file — fetched fresh on every
	 * request so a rotated key list at the source is picked up automatically.
	 * Prompts the user once when neither a source nor an inline key exists.
	 * @param provider Provider name used to look up the provider-specific secret.
	 * @param proxyUrl Proxy applied when the remote source is an HTTP(S) URL.
	 */
	private async resolveApiKeys(provider?: string, proxyUrl?: string): Promise<string[]> {
		if (provider && provider.trim() !== "") {
			const normalizedProvider = provider.trim().toLowerCase();
			const source = await this.secrets.get(`customcopilot.apiKeySource.${normalizedProvider}`);
			if (source && source.trim()) {
				// Remote source configured: fetch a fresh key list per request.
				const remoteKeys = await resolveApiKeysFromSource(source, { proxyUrl });
				if (remoteKeys.length > 0) {
					return remoteKeys;
				}
				// Source unreachable/empty: fall back to any inline keys (no prompt).
				const inline = await this.secrets.get(`customcopilot.apiKey.${normalizedProvider}`);
				return parseApiKeys(inline ?? "");
			}
		}
		const existing = await this.ensureApiKey(provider);
		return parseApiKeys(existing);
	}

	/**
	 * Ensure a per-provider API key exists in SecretStorage, prompting the user when missing.
	 * @param provider Provider name used to look up the provider-specific API key.
	 */
	private async ensureApiKey(provider?: string): Promise<string | undefined> {
		if (!provider || provider.trim() === "") {
			return undefined;
		}
		const normalizedProvider = provider.trim().toLowerCase();
		const providerKey = `customcopilot.apiKey.${normalizedProvider}`;
		let apiKey = await this.secrets.get(providerKey);

		if (!apiKey) {
			const entered = await vscode.window.showInputBox({
				title: `API Key for ${normalizedProvider}`,
				prompt: `Enter your API key for ${normalizedProvider}`,
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store(providerKey, apiKey);
			}
		}
		return apiKey;
	}
}

interface OpenAIResponsesStatefulMarkerLocation {
	marker: string;
	index: number;
}

function createOpenAIResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, CustomEndpointChatProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME);
}

function parseOpenAIResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== "object") {
		return null;
	}
	if (typeof maybe.mimeType !== "string") {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== CustomEndpointChatProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const sep = decoded.indexOf("\\");
		if (sep <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, sep).trim();
		const marker = decoded.slice(sep + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastOpenAIResponsesStatefulMarker(
	modelId: string,
	messages: readonly LanguageModelChatRequestMessage[]
): OpenAIResponsesStatefulMarkerLocation | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[i].content ?? []) {
			const parsed = parseOpenAIResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index: i };
			}
		}
	}
	return null;
}
