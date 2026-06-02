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

import type { HFApiMode, HFModelItem } from "./types";

import type { OllamaRequestBody } from "./ollama/ollamaTypes";

import { parseModelId, createRetryConfig, executeWithRetry, normalizeUserModels, resolveProxyUrl } from "./utils";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { countMessageTokens } from "./provideToken";
import { updateContextStatusBar } from "./statusBar";
import { notifyChatRequestStart } from "./chatActivity";
import { keyBalancer, parseApiKeys } from "./keyBalancer";
import { OllamaApi } from "./ollama/ollamaApi";
import { OpenaiApi } from "./openai/openaiApi";
import { OpenaiResponsesApi } from "./openai/openaiResponsesApi";
import { AnthropicApi } from "./anthropic/anthropicApi";
import { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { GeminiApi, buildGeminiGenerateContentUrl, type GeminiToolCallMeta } from "./gemini/geminiApi";
import type { GeminiGenerateContentRequest } from "./gemini/geminiTypes";
import { CommonApi } from "./commonApi";
import { logger } from "./logger";
import { buildFetchNetworkInit } from "./network";

/**
 * VS Code Chat provider backed by Hugging Face Inference Providers.
 */
export class HuggingFaceChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	private readonly _geminiToolCallMetaByCallId = new Map<string, GeminiToolCallMeta>();
	private readonly _openaiResponsesPreviousResponseIdUnsupportedBaseUrls = new Set<string>();

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
		private readonly vendorApiMode?: HFApiMode
	) {}

	/**
	 * Get the list of available language models contributed by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token which signals if the user cancelled the request or not
	 * @returns A promise that resolves to the list of available language models
	 */
	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
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
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		return countMessageTokens(text, { includeReasoningInRequest: true });
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
			try {
				await this.runChatResponse(model, messages, options, trackingProgress, token);
				return;
			} catch (err) {
				const canRetry = chatRetries < 0 || chatAttempt < chatRetries;
				if (token.isCancellationRequested || hasReported || !canRetry) {
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
				if (delayMs > 0) {
					await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
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
		try {
			// get model config from user settings
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

			// Parse model ID to handle config ID
			const parsedModelId = parseModelId(model.id);

			// Find matching user model configuration
			// Prioritize matching models with same base ID and config ID
			// If no config ID, match models with same base ID
			let um: HFModelItem | undefined = userModels.find(
				(um) =>
					um.id === parsedModelId.baseId &&
					((parsedModelId.configId && um.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !um.configId))
			);

			// If still no model found, try to find any model matching the base ID (most lenient match, for backward compatibility)
			if (!um) {
				um = userModels.find((um) => um.id === parsedModelId.baseId);
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
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
			};

			// Update Token Usage
			updateContextStatusBar(messages, options.tools, model, this.statusBarItem, modelConfig);

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
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key(s) for the model's provider. Multiple keys (stored
			// newline-separated under the same secret) are load-balanced per request.
			const provider = um?.owned_by;
			const normalizedProvider = (provider ?? "").trim().toLowerCase();
			const apiKeys = await this.resolveApiKeys(provider);
			if (apiKeys.length === 0) {
				logger.warn("apiKey.missing", {
					provider: provider ?? "",
				});
				throw new Error("API key not configured");
			}

			// send chat request
			const BASE_URL = baseUrl;
			if (!BASE_URL || !BASE_URL.startsWith("http")) {
				throw new Error(`Invalid base URL configuration.`);
			}

			// get retry config
			const retryConfig = createRetryConfig();
			// With multiple keys, allow enough retry attempts to cycle through the
			// pool and also rotate on auth failures (a bad/limited key should be
			// benched and another tried instead of surfacing the error).
			if (apiKeys.length > 1) {
				retryConfig.max_attempts = Math.max(retryConfig.max_attempts ?? 3, apiKeys.length + 1);
				retryConfig.status_codes = [...new Set([...(retryConfig.status_codes ?? []), 401, 403, 408, 409])];
			}
			const proxyUrl = resolveProxyUrl(um?.proxyUrl, config.get<string>("customcopilot.proxyUrl", "").trim());
			const requestNetworkInit = buildFetchNetworkInit(proxyUrl);

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
				return CommonApi.prepareHeaders(lastSelectedKey, apiMode, um?.headers, um?.userAgent);
			};
			// A "fatal" key error means this specific key cannot be used (quota
			// exhausted, invalid/disabled key, forbidden). Such a key is benched
			// hard so the balancer immediately rotates to another one.
			const isFatalKeyError = (status: number, body: string): boolean => {
				if (status === 401 || status === 403) {
					return true;
				}
				if (status === 429) {
					return /insufficient_quota|invalid_api_key|billing|access_terminated|account_deactivated|exceeded your current quota/i.test(
						body
					);
				}
				return false;
			};
			// Records the failure against the current key and returns an Error to
			// throw. When the key is dead (fatal) and other keys exist, the error is
			// flagged `retryImmediately` so executeWithRetry rotates without backoff.
			const handleKeyError = (status: number, statusText: string, body: string, message: string): Error => {
				const fatal = isFatalKeyError(status, body);
				keyBalancer.reportError(normalizedProvider, lastSelectedKey, {
					fatal,
					message: `[${status}] ${statusText}`,
				});
				const err = new Error(message) as Error & {
					status?: number;
					errorText?: string;
					retryImmediately?: boolean;
				};
				err.status = status;
				err.errorText = body;
				if (fatal && apiKeys.length > 1) {
					err.retryImmediately = true;
				}
				return err;
			};
			logger.debug("request.headers", {
				keyPoolSize: apiKeys.length,
			});
			logger.debug("request.messages.origin", {
				messages: messages,
			});
			if (apiMode === "ollama") {
				// Ollama native API mode
				const ollamaApi = new OllamaApi(model.id);
				const ollamaMessages = ollamaApi.convertMessages(messages, modelConfig);

				let ollamaRequestBody: OllamaRequestBody = {
					model: parsedModelId.baseId,
					messages: ollamaMessages,
					stream: true,
				};
				ollamaRequestBody = ollamaApi.prepareRequestBody(ollamaRequestBody, um, options);

				// send Ollama chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/api/chat`;
				logger.debug("request.body", {
					url: url,
					requestBody: ollamaRequestBody,
				});
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						...requestNetworkInit,
						method: "POST",
						headers: selectRequestHeaders(),
						body: JSON.stringify(ollamaRequestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Ollama Provider] Ollama API error response", errorText);
						throw handleKeyError(
							res.status,
							res.statusText,
							errorText,
							`Ollama API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					keyBalancer.reportSuccess(normalizedProvider, lastSelectedKey);
					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Ollama API");
				}
				await ollamaApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "anthropic") {
				// Anthropic API mode
				const anthropicApi = new AnthropicApi(model.id);
				const anthropicMessages = anthropicApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: AnthropicRequestBody = {
					model: parsedModelId.baseId,
					messages: anthropicMessages,
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

				// send Anthropic chat request with retry
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				// Some providers require configuring the baseUrl with a version suffix (e.g. .../v1).
				// Avoid double-appending (e.g. .../v1/v1/messages).
				const url = normalizedBaseUrl.endsWith("/v1")
					? `${normalizedBaseUrl}/messages`
					: `${normalizedBaseUrl}/v1/messages`;
				logger.debug("request.body", { url, requestBody });
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						...requestNetworkInit,
						method: "POST",
						headers: selectRequestHeaders(),
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Anthropic Provider] Anthropic API error response", errorText);
						throw handleKeyError(
							res.status,
							res.statusText,
							errorText,
							`Anthropic API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					keyBalancer.reportSuccess(normalizedProvider, lastSelectedKey);
					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);
			} else if (apiMode === "openai-responses") {
				// OpenAI Responses API mode
				const openaiResponsesApi = new OpenaiResponsesApi(model.id);
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				const statefulModelId = parsedModelId.baseId;

				// Convert full history once (also extracts system `instructions`).
				const fullInput = openaiResponsesApi.convertMessages(messages, modelConfig);

				const marker = findLastOpenAIResponsesStatefulMarker(statefulModelId, messages);
				let deltaInput: unknown[] | null = null;
				if (marker && marker.index >= 0 && marker.index < messages.length - 1) {
					const deltaMessages = messages.slice(marker.index + 1);
					const converted = openaiResponsesApi.convertMessages(deltaMessages, modelConfig);
					if (converted.length > 0) {
						deltaInput = converted;
					}
				}

				const canUsePreviousResponseId =
					!!marker?.marker &&
					!this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.has(normalizedBaseUrl) &&
					Array.isArray(deltaInput) &&
					deltaInput.length > 0;

				const input = canUsePreviousResponseId ? deltaInput! : fullInput;

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					input,
					stream: true,
				};

				requestBody = openaiResponsesApi.prepareRequestBody(requestBody, um, options);

				// Add prompt_cache_key to enable OpenAI prompt caching.
				// Without this parameter, cached_tokens is always 0 even with identical requests.
				if (!requestBody.prompt_cache_key) {
					requestBody.prompt_cache_key = `customcopilot-${parsedModelId.baseId}`;
				}
				// send Responses API request with retry
				const url = `${normalizedBaseUrl}/responses`;
				logger.debug("request.body", { url, requestBody });

				// If the user explicitly set `previous_response_id` via `extra`, don't apply stateful slicing.
				let addedPreviousResponseId = false;
				if (requestBody.previous_response_id !== undefined) {
					requestBody.input = fullInput;
				} else if (canUsePreviousResponseId) {
					requestBody.previous_response_id = marker!.marker;
					addedPreviousResponseId = true;
				}

				const sendRequest = async (body: Record<string, unknown>) =>
					await executeWithRetry(async () => {
						const res = await fetch(url, {
							...requestNetworkInit,
							method: "POST",
							headers: selectRequestHeaders(),
							body: JSON.stringify(body),
						});

						if (!res.ok) {
							const errorText = await res.text();
							throw handleKeyError(
								res.status,
								res.statusText,
								errorText,
								`Responses API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
							);
						}

						keyBalancer.reportSuccess(normalizedProvider, lastSelectedKey);
						return res;
					}, retryConfig);

				let response: Response;
				try {
					response = await sendRequest(requestBody);
				} catch (err) {
					// Some Responses-compatible gateways don't support `previous_response_id`.
					// Fall back to sending full history when the previous-response attempt fails.
					const status = (err as { status?: unknown })?.status;
					const shouldFallback =
						addedPreviousResponseId && typeof status === "number" && status >= 400 && status < 500 && status !== 429;
					if (!shouldFallback) {
						throw err;
					}

					this._openaiResponsesPreviousResponseIdUnsupportedBaseUrls.add(normalizedBaseUrl);

					let fallbackBody: Record<string, unknown> = {
						model: parsedModelId.baseId,
						input: fullInput,
						stream: true,
					};
					fallbackBody = openaiResponsesApi.prepareRequestBody(fallbackBody, um, options);
					delete fallbackBody.previous_response_id;
					response = await sendRequest(fallbackBody);
				}

				if (!response.body) {
					throw new Error("No response body from Responses API");
				}
				await openaiResponsesApi.processStreamingResponse(response.body, trackingProgress, token);

				// Append a stateful marker so future requests can reuse `previous_response_id` (Copilot Chat style).
				const responseId = openaiResponsesApi.responseId;
				if (responseId) {
					trackingProgress.report(createOpenAIResponsesStatefulMarkerPart(statefulModelId, responseId));
				}
			} else if (apiMode === "gemini") {
				// Gemini native API mode
				const geminiApi = new GeminiApi(model.id, this._geminiToolCallMetaByCallId);
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

				let requestBody: GeminiGenerateContentRequest = {
					contents,
				};
				if (systemParts.length > 0) {
					requestBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n") }] };
				}
				requestBody = geminiApi.prepareRequestBody(requestBody, um, options);

				const url = buildGeminiGenerateContentUrl(BASE_URL, parsedModelId.baseId, true);
				logger.debug("request.body", { url, requestBody });
				if (!url) {
					throw new Error("Invalid Gemini base URL configuration.");
				}

				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						...requestNetworkInit,
						method: "POST",
						headers: selectRequestHeaders(),
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Gemini Provider] Gemini API error response", errorText);
						throw handleKeyError(
							res.status,
							res.statusText,
							errorText,
							`Gemini API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					keyBalancer.reportSuccess(normalizedProvider, lastSelectedKey);
					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Gemini API");
				}
				await geminiApi.processStreamingResponse(response.body, trackingProgress, token);
			} else {
				// OpenAI compatible API mode (default)
				const openaiApi = new OpenaiApi(model.id);
				const openaiMessages = openaiApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: parsedModelId.baseId,
					messages: openaiMessages,
					stream: true,
					stream_options: { include_usage: true },
				};
				requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

				// send chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
				logger.debug("request.body", { url, requestBody });
				const response = await executeWithRetry(async () => {
					const res = await fetch(url, {
						...requestNetworkInit,
						method: "POST",
						headers: selectRequestHeaders(),
						body: JSON.stringify(requestBody),
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[customcopilot] API error response", errorText);
						throw handleKeyError(
							res.status,
							res.statusText,
							errorText,
							`API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
						);
					}

					keyBalancer.reportSuccess(normalizedProvider, lastSelectedKey);
					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from API");
				}
				await openaiApi.processStreamingResponse(response.body, trackingProgress, token);
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
		}
	}

	/**
	 * Resolve the pool of API keys for a provider. Multiple keys are stored
	 * newline-separated under the same per-provider secret; a single key (legacy
	 * format) yields a one-element pool. Prompts the user once when none exist.
	 * @param provider Provider name used to look up the provider-specific secret.
	 */
	private async resolveApiKeys(provider?: string): Promise<string[]> {
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
	return new vscode.LanguageModelDataPart(bytes, HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME);
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
	if (maybe.mimeType !== HuggingFaceChatModelProvider.OPENAI_RESPONSES_STATEFUL_MARKER_MIME) {
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
