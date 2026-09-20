import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { CustomModelItem } from "../types";

import type {
	AnthropicMessage,
	AnthropicRequestBody,
	AnthropicContentBlock,
	AnthropicToolUseBlock,
	AnthropicToolResultBlock,
	AnthropicStreamChunk,
} from "./anthropicTypes";

import { isImageMimeType, isToolResultPart, collectToolResultText, convertToolsToOpenAI, mapRole } from "../utils";
import { glmModelSupportsThinking, glmReasoningEffort } from "../reasoningEffort";

import { CommonApi } from "../commonApi";
import { accumulateUsage } from "../commonApi";
import { logger } from "../logger";
import { buildFetchNetworkInit, proxyFetch } from "../network";

/**
 * True when a trailing user message's content consists solely of tool_result
 * blocks, i.e. appending more tool_result blocks is a legal merge.
 */
function toolResultsFitForMerge(content: AnthropicContentBlock[]): boolean {
	return content.length > 0 && content.every((b) => (b as { type?: string }).type === "tool_result");
}

/**
 * Merge consecutive same-role messages into one (concatenating content
 * blocks) to satisfy Anthropic's strict role-alternation requirement.
 */
function mergeConsecutiveAnthropicRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];
	for (const m of messages) {
		const last = out[out.length - 1];
		if (last && last.role === m.role) {
			const prev: AnthropicContentBlock[] = Array.isArray(last.content)
				? last.content
				: [{ type: "text", text: String(last.content) }];
			const cur: AnthropicContentBlock[] = Array.isArray(m.content)
				? m.content
				: [{ type: "text", text: String(m.content) }];
			last.content = [...prev, ...cur];
			continue;
		}
		out.push(m);
	}
	return out;
}

export class AnthropicApi extends CommonApi<AnthropicMessage, AnthropicRequestBody> {
	constructor(modelId: string) {
		super(modelId);
	}

	/**
	 * Convert VS Code chat messages to Anthropic message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns Anthropic-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): AnthropicMessage[] {
		// Fresh conversion state per request (adapters are reused across turns).
		this.resetRequestState();
		const out: AnthropicMessage[] = [];

		// System parts are JOINED, not overwritten: Copilot Chat may send
		// multiple system messages and only the last one would survive otherwise.
		const systemParts: string[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: AnthropicToolUseBlock[] = [];
			const toolResults: AnthropicToolResultBlock[] = [];
			const thinkingParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					toolCalls.push({
						type: "tool_use",
						id,
						name: part.name,
						input: (part.input as Record<string, unknown>) ?? {},
					});
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({
						type: "tool_result",
						tool_use_id: callId,
						// Map the tool-error flag so the model can see failures.
						is_error: (part as { isError?: boolean }).isError === true || undefined,
						content,
					});
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			// Handle system messages separately (Anthropic uses top-level system field)
			if (role === "system") {
				if (joinedText) {
					systemParts.push(joinedText);
				}
				continue;
			}

			// Build content blocks for user/assistant messages.
			// Anthropic requires thinking blocks FIRST in assistant content.
			const contentBlocks: AnthropicContentBlock[] = [];

			// Add thinking content for assistant messages. IMPORTANT: the
			// Anthropic API rejects replayed thinking blocks without a valid
			// `signature` (400 "Invalid signature in thinking block"), and VS
			// Code's ThinkingPart carries no signature — so thinking is only
			// replayed for the LATEST assistant turn (the pattern used by
			// production Anthropic clients), and never fabricated.
			if (role === "assistant" && modelConfig.includeReasoningInRequest && joinedThinking) {
				contentBlocks.push({
					type: "thinking",
					thinking: joinedThinking,
				});
			}

			// Add text content
			if (joinedText) {
				contentBlocks.push({
					type: "text",
					text: joinedText,
				});
			}

			// Add image content
			for (const imagePart of imageParts) {
				const base64Data = Buffer.from(imagePart.data).toString("base64");
				contentBlocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: imagePart.mimeType,
						data: base64Data,
					},
				});
			}

			// Add tool calls for assistant messages
			for (const toolCall of toolCalls) {
				contentBlocks.push(toolCall);
			}

			// Tool results live in user messages. When a tool result follows
			// other content (or several tool results arrive as separate user
			// messages), they are appended to/merged into ONE user turn —
			// Anthropic 400s on consecutive same-role messages.
			if (role === "user" && toolResults.length > 0) {
				const last = out[out.length - 1];
				if (last && last.role === "user" && Array.isArray(last.content) && toolResultsFitForMerge(last.content)) {
					for (const toolResult of toolResults) {
						last.content.push(toolResult);
					}
					continue;
				}
				for (const toolResult of toolResults) {
					contentBlocks.push(toolResult);
				}
			} else if (toolResults.length > 0) {
				// If tool results appear in non-user messages, log warning
				console.warn("[Anthropic Provider] Tool results found in non-user message, ignoring");
				logger.warn("anthropic.tool-results.non-user", {
					messageRole: role,
					toolResultCount: toolResults.length,
				});
			}

			// Only add message if we have content blocks
			if (contentBlocks.length > 0) {
				out.push({
					role,
					content: contentBlocks,
				});
			}
		}

		if (systemParts.length > 0) {
			this._systemContent = systemParts.join("\n\n");
		}

		// Final safety: merge any remaining consecutive same-role messages
		// (e.g. user text turn directly followed by a user tool-result turn
		// that could not be merged above) — Anthropic requires alternation.
		return mergeConsecutiveAnthropicRoles(out);
	}

	prepareRequestBody(
		rb: AnthropicRequestBody,
		um: CustomModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): AnthropicRequestBody {
		// Set max_tokens (required for Anthropic).
		// Z.AI crashes with 500 if max_tokens is missing (NoneType comparison bug on their side).
		// Always emit a sensible default so the field is never absent.
		if (um?.max_tokens !== undefined) {
			rb.max_tokens = um.max_tokens;
		} else {
			rb.max_tokens = 16384;
		}

		// Add system content if we extracted it
		if (this._systemContent) {
			rb.system = this._systemContent;
		}

		// Add temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// Add top_p if configured
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// Add top_k if configured
		if (um?.top_k !== undefined) {
			rb.top_k = um.top_k;
		}

		// Map extended-thinking options.  `enable_thinking`/`thinking_budget`
		// are the generic UI fields; the Zai-style `thinking: {type}` object is
		// also honored.  Note the Anthropic API requires budget_tokens >= 1024
		// when thinking is enabled, AND max_tokens > budget_tokens (the model
		// needs headroom for the visible answer on top of the thinking
		// budget) — otherwise the API 400s and the request dies (ported from
		// hermes-agent `_thinking_kwargs`: max_tokens = max(effective,
		// budget + 4096)).
		const zaiThinkingEnabled = um?.thinking?.type === "enabled";
		if (um?.enable_thinking === true || zaiThinkingEnabled) {
			const budget =
				um?.thinking_budget ??
				(um?.max_tokens !== undefined ? Math.max(1024, Math.floor(um.max_tokens * 0.8)) : 4096);
			const safeBudget = Math.max(1024, budget);
			rb.thinking = { type: "enabled", budget_tokens: safeBudget };
			// Ensure the output ceiling always exceeds the thinking budget by
			// a comfortable answer allowance — previously a user-set
			// max_tokens smaller than the budget made the model "think past
			// its tokens" and the request fail with a 400.
			rb.max_tokens = Math.max(rb.max_tokens ?? 0, safeBudget + 4096);
			// Anthropic constraint: temperature must be 1 when thinking is on.
			rb.temperature = 1;
		} else if (um?.enable_thinking === false && !um?.extra?.thinking) {
			// Explicitly disabled — don't send the field at all (absence = off).
			delete rb.thinking;
		}

		// GLM-5.2/5.3 over the Anthropic-compatible wire (z.ai) also take a
		// native `reasoning_effort`, clamped onto the family's vocabulary
		// (ported from hermes-agent's zai profile): 5.2 = high/max, 5.3 =
		// low..max. Only emit when the user expressed a preference; the effort
		// is NOT forwarded for models whose family doesn't support thinking.
		if (typeof um?.reasoning_effort === "string" && glmModelSupportsThinking(um.id)) {
			const effort = glmReasoningEffort(um.reasoning_effort, um.id);
			if (effort) {
				(rb as unknown as Record<string, unknown>).reasoning_effort = effort;
			}
		}

		// Add tools configuration
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			// Convert OpenAI tool definitions to Anthropic format
			rb.tools = toolConfig.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters,
			}));
		}

		// Add tool_choice
		if (toolConfig.tool_choice) {
			if (toolConfig.tool_choice === "auto") {
				rb.tool_choice = { type: "auto" };
			} else if (typeof toolConfig.tool_choice === "object" && toolConfig.tool_choice.type === "function") {
				rb.tool_choice = { type: "tool", name: toolConfig.tool_choice.function.name };
			}
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
	 * Process Anthropic streaming response (SSE format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const modelId = this._modelId;
		// Fresh streaming state per response (adapters are reused across turns/retries).
		this.resetRequestState();
		logger.debug("anthropic.stream.start", { modelId });

		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim() === "") {
						continue;
					}
					if (!line.startsWith("data:")) {
						continue;
					}

					const data = line.slice(5).trim();
					logger.debug("anthropic.stream.chunk", { modelId, data });
					if (data === "[DONE]") {
						// Do not throw on [DONE]; any incomplete/empty buffers are ignored.
						await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
						continue;
					}

					try {
						const chunk: AnthropicStreamChunk = JSON.parse(data);
						await this.processAnthropicChunk(chunk, progress);
					} catch (e) {
						console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
						logger.error("anthropic.stream.chunk.error", {
							modelId,
							error: e instanceof Error ? e.message : String(e),
							data,
						});
					}
				}
			}
			logger.debug("anthropic.stream.done", { modelId });
		} catch (e) {
			console.error("[Anthropic Provider] Streaming response error:", e);
			logger.error("anthropic.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			reader.releaseLock();
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);
		}
	}

	/**
	 * Process a single Anthropic streaming chunk.
	 * @param chunk Parsed Anthropic stream chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processAnthropicChunk(
		chunk: AnthropicStreamChunk,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		// Handle ping events (ignore)
		if (chunk.type === "ping") {
			return;
		}

		// Handle error events: surface as a thrown error instead of silently
		// truncating the answer (the user would see a partial response with
		// no indication anything went wrong).
		if (chunk.type === "error") {
			const errorType = chunk.error?.type || "unknown_error";
			const errorMessage = chunk.error?.message || "Anthropic API streaming error";
			console.error(`[Anthropic Provider] Streaming error: ${errorType} - ${errorMessage}`);
			throw new Error(`Anthropic streaming error (${errorType}): ${errorMessage}`);
		}

		if (chunk.type === "message_start" && chunk.message) {
			// message_start carries the input (prompt) token count — the
			// basis of the context-usage circle.
			const inputTokens = (chunk.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
			if (inputTokens) {
				this._lastUsage = accumulateUsage(this._lastUsage, {
					prompt_tokens:
						(inputTokens.input_tokens ?? 0) +
						(inputTokens.cache_read_input_tokens ?? 0) +
						(inputTokens.cache_creation_input_tokens ?? 0),
					prompt_tokens_details: {
						cached_tokens: (inputTokens.cache_read_input_tokens ?? 0),
					},
				});
			}
			return;
		}

		if (chunk.type === "message_delta" && chunk.delta) {
			// message_delta carries the final output token count.
			const usage = (chunk as { usage?: { output_tokens?: number } }).usage;
			if (usage?.output_tokens !== undefined) {
				this._lastUsage = accumulateUsage(this._lastUsage, { completion_tokens: usage.output_tokens });
			}
			return;
		}

		if (chunk.type === "content_block_start" && chunk.content_block) {
			// Start of a content block
			if (chunk.content_block.type === "thinking") {
				// Start thinking block
				if (chunk.content_block.thinking) {
					this.bufferThinkingContent(chunk.content_block.thinking, progress);
				}
			} else if (chunk.content_block.type === "tool_use") {
				// Start tool call block
				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}
				const idx = (chunk.index as number) ?? 0;
				this._toolCallBuffers.set(idx, {
					id: chunk.content_block.id,
					name: chunk.content_block.name,
					args: "",
				});
			} else if (chunk.content_block.type === "text") {
				// Text block start - nothing special to do
				// The text content will come via content_block_delta events
			}
		} else if (chunk.type === "content_block_delta" && chunk.delta) {
			if (chunk.delta.type === "text_delta" && chunk.delta.text) {
				// Emit text content
				progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
				this._hasEmittedAssistantText = true;
			} else if (chunk.delta.type === "thinking_delta" && chunk.delta.thinking) {
				// Buffer thinking content
				this.bufferThinkingContent(chunk.delta.thinking, progress);
			} else if (chunk.delta.type === "input_json_delta" && chunk.delta.partial_json) {
				// Handle tool call argument streaming
				// Find the latest tool call buffer and append partial JSON
				const idx = (chunk.index as number) ?? 0;
				const buf = this._toolCallBuffers.get(idx);
				if (buf) {
					buf.args += chunk.delta.partial_json;
					this._toolCallBuffers.set(idx, buf);
					// Try to emit if we have valid JSON
					await this.tryEmitBufferedToolCall(idx, progress);
				}
			} else if (chunk.delta.type === "signature_delta" && chunk.delta.signature) {
				// Signature for the current thinking block. Stored on the
				// adapter so convertMessages could replay it if VS Code's
				// ThinkingPart ever carries it; today it is simply not
				// discardable evidence — log at debug for diagnostics.
				logger.debug("anthropic.thinking.signature", { modelId: this._modelId });
			}
		} else if (chunk.type === "content_block_stop") {
			// End of ONE content block: finalize only that block's index.
			// Flushing ALL buffers here would emit incomplete sibling tool_use
			// blocks and permanently break parallel tool calls.
			const idx = (chunk.index as number) ?? 0;
			await this.flushToolCallBufferAt(idx, progress, /*throwOnInvalid*/ false);
		} else if (chunk.type === "message_stop") {
			// End of message - ensure thinking is ended and flush all tool calls
			await this.flushToolCallBuffers(progress, false);
			this.reportEndThinking(progress);
		}
	}

	async *createMessage(
		model: CustomModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }> {
		// For Anthropic, we need to separate system prompt from messages
		const anthropicMessages: AnthropicMessage[] = messages.map((m) => ({
			role: m.role === "user" || m.role === "assistant" ? m.role : "user",
			content: m.content,
		}));
		this._systemContent = systemPrompt;

		// requestBody
		let requestBody: AnthropicRequestBody = {
			model: model.id,
			messages: anthropicMessages,
			stream: true,
		};
		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai", model.headers, model.userAgent);
		const networkInit = buildFetchNetworkInit(model.proxyUrl);

		const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
		// Some providers require configuring the baseUrl with a version suffix (e.g. .../v1).
		// Avoid double-appending (e.g. .../v1/v1/messages).
		const url = normalizedBaseUrl.endsWith("/v1")
			? `${normalizedBaseUrl}/messages`
			: `${normalizedBaseUrl}/v1/messages`;

		// Make the API request
		const response = await proxyFetch(url, {
			...networkInit,
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from Anthropic API");
		}

		// Process the response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim() === "") continue;
					if (!line.startsWith("data:")) continue;

					const data = line.slice(5).trim();
					if (data === "[DONE]") continue;

					try {
						const chunk: AnthropicStreamChunk = JSON.parse(data);

						// Anthropic streaming response
						if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta" && chunk.delta?.text) {
							yield { type: "text", text: chunk.delta.text };
						}

						// Handle message stop
						if (chunk.type === "message_stop") break;

						// Handle error responses
						if (chunk.type === "error") {
							const errorType = chunk.error?.type || "unknown_error";
							const errorMessage = chunk.error?.message || "Anthropic API streaming error";
							console.error(`[Anthropic Provider] Streaming error: ${errorType} - ${errorMessage}`);
						}
					} catch (e) {
						console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}

/**
 * Fetch the list of available models from an Anthropic-compatible endpoint.
 *
 * Anthropic's `/v1/models` endpoint uses `x-api-key` + `anthropic-version`
 * headers instead of the OpenAI-style `Authorization: Bearer` header, and the
 * response payload differs (`{ data: [{ id, display_name, created_at }], has_more }`).
 *
 * @param baseUrl The base URL of the Anthropic-compatible endpoint.
 * @param apiKey The API key for authentication.
 * @param customHeaders Optional extra headers to merge.
 * @param networkOptions Optional proxy/user-agent settings.
 * @returns A list of normalized model items.
 */
export async function fetchAnthropicModels(
	baseUrl: string,
	apiKey: string,
	customHeaders?: Record<string, string>,
	networkOptions?: { proxyUrl?: string; userAgent?: string },
	apiMode = "anthropic"
): Promise<CustomModelItem[]> {
	const headers = CommonApi.prepareHeaders(apiKey, apiMode, customHeaders, networkOptions?.userAgent);
	headers["Accept"] = "application/json";
	const networkInit = buildFetchNetworkInit(networkOptions?.proxyUrl);

	const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
	const modelsUrl = normalizedBaseUrl.endsWith("/v1")
		? `${normalizedBaseUrl}/models`
		: `${normalizedBaseUrl}/v1/models`;

	const models: CustomModelItem[] = [];
	let afterId: string | undefined;
	let page = 0;

	while (page < 20) {
		const url = new URL(modelsUrl);
		url.searchParams.set("limit", "100");
		if (afterId) {
			url.searchParams.set("after_id", afterId);
		}

		const resp = await proxyFetch(url.toString(), {
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
				`Anthropic API error: [${resp.status}] ${resp.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url.toString()}`
			);
		}

		const parsed = (await resp.json()) as {
			data?: Array<{ id: string; display_name?: string; created_at?: string }>;
			has_more?: boolean;
			last_id?: string;
		};
		const entries = parsed.data ?? [];
		for (const entry of entries) {
			// GLM models (z.ai) support up to 1M context window.
			// The /v1/models endpoint doesn't return context_length so we set it here.
			const isGlm = entry.id.toLowerCase().startsWith("glm");
			models.push({
				id: entry.id,
				displayName: entry.display_name || entry.id,
				owned_by: apiMode === "zai" ? "zai" : "anthropic",
				apiMode: apiMode as import("../types").CustomApiMode,
				context_length: apiMode === "zai" && isGlm ? 1_000_000 : undefined,
				max_tokens: apiMode === "zai" ? 16384 : undefined,
				tool_calling: true,
				vision: true,
			} as CustomModelItem);
		}

		if (!parsed.has_more || !parsed.last_id) {
			break;
		}
		afterId = parsed.last_id;
		page += 1;
	}

	return models;
}
