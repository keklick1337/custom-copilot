import type { MessageConversionConfig } from "../commonApi";
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { CustomModelItem } from "../types";

import type { OllamaMessage, OllamaRequestBody, OllamaStreamChunk, OllamaToolCall } from "./ollamaTypes";

import {
	isImageMimeType,
	isToolResultPart,
	collectToolResultText,
	collectToolResultImages,
	convertToolsToOpenAI,
	mapRole,
	resolveThinkingEnabled,
} from "../utils";

import { CommonApi, accumulateUsage } from "../commonApi";
import { logger } from "../logger";
import { buildFetchNetworkInit, proxyFetch } from "../network";
import { VersionManager } from "../versionManager";

export class OllamaApi extends CommonApi<OllamaMessage, OllamaRequestBody> {
	constructor(modelId: string) {
		super(modelId);
	}

	/**
	 * Convert VS Code chat messages to Ollama native message format.
	 * @param messages The VS Code chat messages to convert.
	 * @returns Ollama-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: MessageConversionConfig
	): OllamaMessage[] {
		// Fresh conversion state per request (adapters are reused across turns).
		this.resetRequestState();
		const out: OllamaMessage[] = [];

		// Ollama tool messages are matched by tool NAME (calls carry no id):
		// remember the name of every assistant tool call by its callId.
		const toolNameByCallId = new Map<string, string>();

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: string[] = [];
			let thinkingContent = "";
			const toolCalls: OllamaToolCall[] = [];
			const toolResults: { toolName: string; content: string; images: string[] }[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					// Convert image data to base64 for Ollama
					if (isImageMimeType(part.mimeType)) {
						const base64Data = Buffer.from(part.data).toString("base64");
						imageParts.push(base64Data);
					}
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					// Capture thinking content
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingContent += content;
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					// Capture tool calls from assistant
					if (part.callId) {
						toolNameByCallId.set(part.callId, part.name);
					}
					toolCalls.push({
						function: {
							name: part.name,
							arguments: (part.input as Record<string, unknown>) ?? {},
						},
					});
				} else if (isToolResultPart(part)) {
					// Capture tool results
					const content = collectToolResultText(part);
					const toolName = toolNameByCallId.get(part.callId) ?? "unknown";
					const images = collectToolResultImages(part).map((img) => Buffer.from(img.data).toString("base64"));
					toolResults.push({ toolName, content, images });
				}
			}

			// Handle tool results as separate "tool" role messages
			for (const tr of toolResults) {
				const toolMessage: OllamaMessage = {
					role: "tool",
					content: tr.content,
					tool_name: tr.toolName,
				};
				if (tr.images.length > 0) {
					toolMessage.images = tr.images;
				}
				out.push(toolMessage);
			}

			// Handle regular messages
			const content = textParts.join("").trim();
			if (content || imageParts.length > 0 || toolCalls.length > 0) {
				const ollamaMessage: OllamaMessage = {
					role,
					content,
				};

				if (imageParts.length > 0) {
					ollamaMessage.images = imageParts;
				}

				if (_modelConfig.includeReasoningInRequest && thinkingContent.trim() && role === "assistant") {
					ollamaMessage.thinking = thinkingContent;
				}

				if (toolCalls.length > 0 && role === "assistant") {
					ollamaMessage.tool_calls = toolCalls;
				}

				out.push(ollamaMessage);
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: OllamaRequestBody,
		um: CustomModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): OllamaRequestBody {
		// Model options. `num_ctx` is essential: without it Ollama runs the
		// model with its small default window (2K–8K) and SILENTLY truncates
		// Copilot's prompt from the front (hermes sends options.num_ctx).
		const modelOptions: NonNullable<OllamaRequestBody["options"]> = {};
		if (um?.temperature !== undefined && um.temperature !== null) {
			modelOptions.temperature = um.temperature;
		}
		if (um?.top_p !== undefined && um.top_p !== null) {
			modelOptions.top_p = um.top_p;
		}
		if (um?.top_k !== undefined) {
			modelOptions.top_k = um.top_k;
		}
		if (um?.min_p !== undefined) {
			modelOptions.min_p = um.min_p;
		}
		if (um?.max_tokens !== undefined) {
			modelOptions.num_predict = um.max_tokens;
		}
		if (typeof um?.context_length === "number" && um.context_length > 0) {
			modelOptions.num_ctx = um.context_length;
		}
		if (um?.repetition_penalty !== undefined) {
			modelOptions.repeat_penalty = um.repetition_penalty;
		}
		if (um?.presence_penalty !== undefined) {
			modelOptions.presence_penalty = um.presence_penalty;
		}
		if (um?.frequency_penalty !== undefined) {
			modelOptions.frequency_penalty = um.frequency_penalty;
		}
		if (Object.keys(modelOptions).length > 0) {
			rb.options = modelOptions;
		}

		// Map the thinking preference to Ollama's `think` flag. gpt-oss only
		// takes graded levels ("low"/"medium"/"high", booleans are ignored);
		// others take a boolean. No preference → model default.
		const thinkingEnabled = resolveThinkingEnabled(um);
		const effort = typeof um?.reasoning_effort === "string" ? um.reasoning_effort.trim().toLowerCase() : "";
		const isGptOss = /gpt-oss/i.test(um?.id ?? "");
		if (thinkingEnabled === false) {
			rb.think = isGptOss ? "low" : false;
		} else if (isGptOss && effort) {
			rb.think = effort === "minimal" || effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
		} else if (thinkingEnabled === true || (effort && effort !== "none")) {
			rb.think = true;
		}

		// Add tools if provided
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			// Add all extra parameters directly to the request body
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					(rb as unknown as Record<string, unknown>)[key] = value;
				}
			}
		}

		return rb;
	}

	/**
	 * Process Ollama native API streaming response (JSON lines format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this.resetRequestState();
		const modelId = this._modelId;
		logger.debug("ollama.stream.start", { modelId });

		let doneReason: string | undefined;
		try {
			for await (const line of this.readStreamLines(responseBody, token)) {
				if (!line.trim()) {
					continue;
				}
				let chunk: OllamaStreamChunk & { error?: unknown; done_reason?: string };
				try {
					chunk = JSON.parse(line);
				} catch (e) {
					console.error("[Ollama Provider] Failed to parse streaming chunk:", e, "data:", line);
					logger.error("ollama.stream.chunk.error", {
						modelId,
						error: e instanceof Error ? e.message : String(e),
						data: line,
					});
					continue;
				}
				logger.debug("ollama.stream.chunk", { modelId, data: chunk });
				// Mid-stream failure (model crashed, OOM…) arrives as {"error": "..."}.
				if (chunk.error) {
					throw new Error(`Ollama stream error: ${typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error)}`);
				}
				await this.processOllamaDelta(chunk, progress);

				// Check if this is the final chunk
				if (chunk.done) {
					doneReason = chunk.done_reason;
					// End any active thinking sequence
					this.reportEndThinking(progress);
				}
			}
			this.reportStopNotice(progress, doneReason);
			logger.debug("ollama.stream.done", { modelId });
		} catch (e) {
			console.error("[Ollama Provider] Streaming response error:", e);
			logger.error("ollama.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			// End any active thinking sequence
			this.reportEndThinking(progress);
		}
	}

	/**
	 * Process a single Ollama streaming chunk.
	 * @param chunk Parsed Ollama stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processOllamaDelta(
		chunk: OllamaStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		// The final chunk carries the token accounting (prompt_eval_count /
		// eval_count) — feeds the context-usage circle.
		if (chunk.done && (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined)) {
			this._lastUsage = accumulateUsage(this._lastUsage, {
				prompt_tokens: chunk.prompt_eval_count,
				completion_tokens: chunk.eval_count,
			});
		}
		const message = chunk.message;
		if (!message) {
			return;
		}

		// Process thinking content first
		if (message.thinking) {
			// Buffer and emit thinking content
			this.bufferThinkingContent(message.thinking, progress);
		}

		// Process tool calls
		if (message.tool_calls && message.tool_calls.length > 0) {
			// End thinking if active
			this.reportEndThinking(progress);

			for (const tc of message.tool_calls) {
				const name = tc?.function?.name;
				if (!name) {
					continue;
				}
				let args: unknown = tc.function.arguments;
				if (typeof args === "string") {
					try {
						args = JSON.parse(args);
					} catch {
						args = {};
					}
				}
				const id = `ollama_tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				progress.report(
					new vscode.LanguageModelToolCallPart(
						id,
						name,
						args && typeof args === "object" ? (args as Record<string, unknown>) : {}
					)
				);
			}
		}

		// Process regular content
		if (message.content) {
			// If we have thinking content and now receiving regular content, end thinking first
			this.reportEndThinking(progress);

			// Emit text content
			progress.report(new vscode.LanguageModelTextPart(message.content));
			this._hasEmittedAssistantText = true;
		}
	}

	async *createMessage(
		model: CustomModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal
	): AsyncGenerator<{ type: "text"; text: string }> {
		// Convert to Ollama message format
		const ollamaMessages: OllamaMessage[] = [];

		// Add system prompt first if provided
		if (systemPrompt) {
			ollamaMessages.push({ role: "system", content: systemPrompt });
		}

		// Add user/assistant messages
		for (const msg of messages) {
			const role = msg.role === "user" || msg.role === "assistant" ? msg.role : "user";
			ollamaMessages.push({ role, content: msg.content });
		}

		// Build request body
		let requestBody: OllamaRequestBody = {
			model: model.id,
			messages: ollamaMessages,
			stream: true,
		};

		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "ollama", model.headers);
		const networkInit = buildFetchNetworkInit(model.proxyUrl);

		const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;

		// Make the API request
		const response = await proxyFetch(url, {
			...networkInit,
			...(signal ? { signal } : {}),
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Ollama API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from Ollama API");
		}

		// Process JSON lines streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}

					try {
						const chunk: OllamaStreamChunk = JSON.parse(line);
						if (chunk.message?.content) {
							yield { type: "text", text: chunk.message.content };
						}

						if (chunk.done) {
							break;
						}
					} catch (e) {
						console.error("[Ollama Provider] Failed to parse streaming chunk:", e, "data:", line);
					}
				}
			}
		} finally {
			// Cancel (not only release) so an abandoned stream frees the socket.
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
}

/**
 * Fetch available models from Ollama API endpoint.
 * Uses /api/tags endpoint to list local models.
 * @param baseUrl The Ollama API base URL.
 * @param _apiKey Ollama doesn't require authentication (ignored).
 * @param customHeaders Optional custom headers to merge with defaults.
 * @returns A promise that resolves to an array of model items.
 */
export async function fetchOllamaModels(
	baseUrl: string,
	_apiKey: string,
	customHeaders?: Record<string, string>,
	networkOptions?: { proxyUrl?: string; userAgent?: string }
): Promise<CustomModelItem[]> {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const url = `${trimmed}/api/tags`;

	const baseHeaders: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": (networkOptions?.userAgent || "").trim() || VersionManager.getUserAgent(),
	};
	const headers = customHeaders ? { ...baseHeaders, ...customHeaders } : baseHeaders;
	const networkInit = buildFetchNetworkInit(networkOptions?.proxyUrl);
	const resp = await proxyFetch(url, {
		...networkInit,
		method: "GET",
		headers,
	});

	if (!resp.ok) {
		let errorText = "";
		try {
			errorText = await resp.text();
		} catch (error) {
			console.error("[customcopilot] Failed to read response text", error);
		}
		throw new Error(
			`Ollama API error: [${resp.status}] ${resp.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url}`
		);
	}

	const parsed = (await resp.json()) as import("./ollamaTypes").OllamaTagsResponse;
	const entries = parsed.models ?? [];

	const models: CustomModelItem[] = [];
	for (const entry of entries) {
		models.push({
			id: entry.model,
			displayName: entry.name,
			owned_by: "ollama",
			apiMode: "ollama",
		} as CustomModelItem);
	}

	return models;
}

/** Result of an Ollama `/api/show` probe. */
export interface OllamaModelInfo {
	/** Runtime window (Modelfile num_ctx), else the GGUF training max. */
	contextLength?: number;
	/** `capabilities` (Ollama 0.6+): "completion", "tools", "thinking", "vision"… */
	capabilities?: string[];
}

const ollamaShowCache = new Map<string, Promise<OllamaModelInfo | undefined>>();

/**
 * Probe `POST {base}/api/show` once per (server, model) — hermes
 * `query_ollama_num_ctx`. Used to send a real `num_ctx` when the user didn't
 * configure `context_length` (otherwise Ollama runs its small default window
 * and silently truncates the prompt) and to gate `think` on models that
 * actually support thinking. Never throws; undefined when unavailable.
 */
export function probeOllamaModel(
	baseUrl: string,
	model: string,
	headers: Record<string, string>,
	networkInit: RequestInit
): Promise<OllamaModelInfo | undefined> {
	const root = baseUrl.replace(/\/+$/, "").replace(/\/(api|v1)$/i, "");
	const key = `${root}|${model}`;
	let pending = ollamaShowCache.get(key);
	if (!pending) {
		pending = (async () => {
			try {
				const resp = await proxyFetch(`${root}/api/show`, {
					...networkInit,
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({ name: model }),
				});
				if (!resp.ok) {
					return undefined;
				}
				const data = (await resp.json()) as {
					parameters?: string;
					model_info?: Record<string, unknown>;
					capabilities?: unknown;
				};
				let contextLength: number | undefined;
				for (const line of (data.parameters ?? "").split("\n")) {
					const parts = line.trim().split(/\s+/);
					if (line.includes("num_ctx") && parts.length >= 2) {
						const n = parseInt(parts[parts.length - 1], 10);
						if (Number.isFinite(n) && n > 0) {
							contextLength = n;
							break;
						}
					}
				}
				if (contextLength === undefined) {
					for (const [k, v] of Object.entries(data.model_info ?? {})) {
						if (k.includes("context_length") && typeof v === "number" && v > 0) {
							contextLength = Math.floor(v);
							break;
						}
					}
				}
				const capabilities = Array.isArray(data.capabilities)
					? data.capabilities.filter((c): c is string => typeof c === "string")
					: undefined;
				return { contextLength, capabilities };
			} catch {
				return undefined;
			}
		})();
		ollamaShowCache.set(key, pending);
		// A failed probe may be retried on a later request.
		void pending.then((info) => {
			if (!info) {
				ollamaShowCache.delete(key);
			}
		});
	}
	return pending;
}

