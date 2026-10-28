import type { MessageConversionConfig } from "../commonApi";
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { CustomModelItem, ReasoningConfig } from "../types";

import type {
	OpenAIChatMessage,
	OpenAIToolCall,
	ChatMessageContent,
	ReasoningDetail,
	ReasoningSummaryDetail,
	ReasoningTextDetail,
} from "./openaiTypes";

import {
	isImageMimeType,
	createDataUrl,
	isToolResultPart,
	collectToolResultText,
	collectToolResultImages,
	convertToolsToOpenAI,
	mapRole,
	safeUrlHost,
	isZaiHost,
	resolveThinkingEnabled,
} from "../utils";
import { clampEffort, compatThinkingParams, glmThinkingParams, OPENAI_COMPAT_WIRE_EFFORTS } from "../reasoningEffort";
import { isMoonshotModel, sanitizeMoonshotToolParameters } from "./moonshotSchema";

import { CommonApi } from "../commonApi";
import { accumulateUsage, type ApiUsage } from "../commonApi";
import { logger } from "../logger";
import { buildFetchNetworkInit, proxyFetch } from "../network";

/** Gemini `extra_content` (thought signatures) by tool call id, for replay. */
const GEMINI_EXTRA_CONTENT_BY_CALL_ID = new Map<string, unknown>();

function rememberGeminiExtraContent(callId: string, extra: unknown): void {
	GEMINI_EXTRA_CONTENT_BY_CALL_ID.set(callId, extra);
	if (GEMINI_EXTRA_CONTENT_BY_CALL_ID.size > 2000) {
		for (const key of GEMINI_EXTRA_CONTENT_BY_CALL_ID.keys()) {
			GEMINI_EXTRA_CONTENT_BY_CALL_ID.delete(key);
			if (GEMINI_EXTRA_CONTENT_BY_CALL_ID.size <= 1500) {
				break;
			}
		}
	}
}

export class OpenaiApi extends CommonApi<OpenAIChatMessage, Record<string, unknown>> {
	constructor(modelId: string) {
		super(modelId);
	}

	/**
	 * Convert VS Code chat request messages into OpenAI-compatible message objects.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns OpenAI-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: MessageConversionConfig
	): OpenAIChatMessage[] {
		// Fresh conversion state per request (adapters are reused across turns).
		this.resetRequestState();
		const out: OpenAIChatMessage[] = [];
		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const toolResultImages: vscode.LanguageModelDataPart[] = [];
			const reasoningParts: string[] = [];
			let reasoningDetails: unknown[] | undefined;

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
					let args = "{}";
					try {
						args = JSON.stringify(part.input ?? {});
					} catch {
						args = "{}";
					}
					const toolCall: OpenAIToolCall = { id, type: "function", function: { name: part.name, arguments: args } };
					// Gemini/Gemma on the OpenAI-compatible endpoint require the
					// thought signature captured with the call (hermes keeps
					// `extra_content.google.thought_signature` for these models).
					const extra = GEMINI_EXTRA_CONTENT_BY_CALL_ID.get(id);
					if (extra && /gemini|gemma/i.test(this._modelId)) {
						(toolCall as OpenAIToolCall & { extra_content?: unknown }).extra_content = extra;
					}
					toolCalls.push(toolCall);
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, content });
					toolResultImages.push(...collectToolResultImages(part as { content?: ReadonlyArray<unknown> }));
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const details = (part.metadata as { reasoning_details?: unknown } | undefined)?.reasoning_details;
					if (Array.isArray(details) && details.length > 0) {
						reasoningDetails = [...(reasoningDetails ?? []), ...details];
					}
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					reasoningParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = reasoningParts.join("").trim();

			// process assistant message
			if (role === "assistant") {
				const assistantMessage: OpenAIChatMessage = {
					role: "assistant",
				};

				if (joinedText) {
					assistantMessage.content = joinedText;
				}

				if (modelConfig.includeReasoningInRequest) {
					// Replay actual thinking only. Providers that REQUIRE the
					// field (DeepSeek/Kimi/MiMo) get a single space pad when no
					// thinking was captured — hermes `_copy_reasoning_content_for_api`;
					// never fabricated text ("" is rejected by DeepSeek V4).
					// Every assistant turn needs the field there (hermes
					// message_sanitization: "every assistant turn still needs it").
					assistantMessage.reasoning_content = joinedThinking || " ";
				}

				// OpenRouter: reasoning blocks (with signatures / encrypted
				// data) must be passed back unmodified to continue a
				// tool-calling turn on Anthropic/Gemini upstreams.
				if (reasoningDetails && modelConfig.replayReasoningDetails) {
					assistantMessage.reasoning_details = reasoningDetails;
				}

				if (toolCalls.length > 0) {
					assistantMessage.tool_calls = toolCalls;
				}

				if (assistantMessage.content || assistantMessage.tool_calls) {
					out.push(assistantMessage);
				}
			}

			// process tool result messages
			for (const tr of toolResults) {
				out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
			}

			// Chat Completions tool messages are text-only: forward tool-result
			// images (screenshots…) in a follow-up user message, the same way
			// Copilot's BYOK OpenAI provider does, instead of dropping them.
			const followUpImages = role === "user" ? [...toolResultImages, ...imageParts] : toolResultImages;

			// process user messages
			if (role === "user") {
				if (followUpImages.length > 0) {
					// multi-modal message
					const contentArray: ChatMessageContent[] = [];

					if (joinedText) {
						contentArray.push({
							type: "text",
							text: joinedText,
						});
					} else if (toolResultImages.length > 0) {
						contentArray.push({ type: "text", text: "Image(s) returned by the tool call above:" });
					}

					for (const imagePart of followUpImages) {
						const dataUrl = createDataUrl(imagePart);
						contentArray.push({
							type: "image_url",
							image_url: {
								url: dataUrl,
							},
						});
					}
					out.push({ role, content: contentArray });
				} else {
					// text-only message
					if (joinedText) {
						out.push({ role, content: joinedText });
					}
				}
			}

			// process system messages
			if (role === "system" && joinedText) {
				out.push({ role, content: joinedText });
			}
		}
		return out;
	}

	prepareRequestBody(
		rb: Record<string, unknown>,
		um: CustomModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> {
		// Groq's OpenAI-compatible wire accepts graded reasoning_effort levels
		// only as "none"/"default" — detect the host once (hermes #75089).
		const groqEndpoint = /(^|\.)api\.groq\.com$/i.test(safeUrlHost(um?.baseUrl));

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// top_p
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// max_tokens / max_completion_tokens (mutually exclusive)
		// max_completion_tokens takes precedence (newer OpenAI standard for reasoning models)
		// Direct OpenAI / Azure and GPT-4o+/o-series/GPT-5 models reject
		// `max_tokens` ("use max_completion_tokens") — hermes
		// `model_forces_max_completion_tokens`.
		const bareModel = (um?.id ?? "").toLowerCase().slice((um?.id ?? "").lastIndexOf("/") + 1);
		const host = safeUrlHost(um?.baseUrl);
		const forcesCompletionTokens =
			host === "api.openai.com" ||
			host.endsWith(".openai.azure.com") ||
			/^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)/.test(bareModel);
		if (um?.max_completion_tokens !== undefined) {
			rb.max_completion_tokens = um.max_completion_tokens;
		} else if (um?.max_tokens !== undefined) {
			if (forcesCompletionTokens) {
				rb.max_completion_tokens = um.max_tokens;
			} else {
				rb.max_tokens = um.max_tokens;
			}
		}

		// Z.AI (api.z.ai / open.bigmodel.cn) GLM wire — hermes ZaiProfile:
		// `thinking: {type}` only when the user expressed a preference, and a
		// top-level `reasoning_effort` only for GLM-5.2/5.3, clamped onto the
		// family's vocabulary (a generic "medium" would 400 on 5.2).
		const zaiEndpoint = isZaiHost(um?.baseUrl);
		// DeepSeek / Kimi / Ollama have their own effort vocabularies and
		// toggles (hermes provider profiles); undefined = generic handling.
		const compat =
			um && !zaiEndpoint
				? compatThinkingParams(
						safeUrlHost(um.baseUrl),
						um.baseUrl ?? "",
						um.id,
						resolveThinkingEnabled(um),
						typeof um.reasoning_effort === "string" ? um.reasoning_effort : undefined
					)
				: undefined;
		if (compat) {
			if (compat.thinking && um?.thinking?.type === undefined) {
				rb.thinking = compat.thinking;
			}
			if (compat.reasoning_effort) {
				rb.reasoning_effort = compat.reasoning_effort;
			}
			if (compat.think !== undefined) {
				rb.think = compat.think;
			}
		} else if (zaiEndpoint && um) {
			const glm = glmThinkingParams(um.id, resolveThinkingEnabled(um), um.reasoning_effort);
			if (glm.thinking) {
				rb.thinking = glm.thinking;
			}
			if (glm.reasoning_effort) {
				rb.reasoning_effort = glm.reasoning_effort;
			}
		} else if (um?.reasoning_effort !== undefined) {
			// OpenAI reasoning configuration. The effort is clamped onto the
			// OpenAI-compat wire vocabulary (ported from hermes-agent): arbitrary
			// endpoints top out at "max", so "ultra" verbatim would 400.
			const effortValue: unknown = um.reasoning_effort;
			if (typeof effortValue === "string") {
				// An explicit "thinking off" (enable_thinking:false / thinking.type
				// disabled) wins over a leftover effort level.
				const normalized = resolveThinkingEnabled(um) === false ? "none" : effortValue.trim().toLowerCase();
				if (normalized === "none") {
					// Explicitly disabled: top-level "none" (Ollama /v1 and most
					// OpenAI-compat servers understand it; never a thinking=True).
					rb.reasoning_effort = "none";
				} else if (groqEndpoint) {
					// Groq's OpenAI-compatible wire accepts reasoning_effort only
					// as "none"/"default"; graded levels 400 (hermes-agent #75089).
					rb.reasoning_effort = "default";
				} else {
					const clamped = clampEffort(normalized, OPENAI_COMPAT_WIRE_EFFORTS);
					rb.reasoning_effort = typeof clamped === "string" ? clamped.trim().toLowerCase() : clamped;
				}
			} else {
				rb.reasoning_effort = effortValue;
			}
		}

		// enable_thinking (non-OpenRouter only; Z.AI uses `thinking` above)
		const enableThinking = um?.enable_thinking;
		if (enableThinking !== undefined && !zaiEndpoint && !compat) {
			rb.enable_thinking = enableThinking;

			if (um?.thinking_budget !== undefined) {
				rb.thinking_budget = um.thinking_budget;
			}
		}

		// thinking (Volcengine/ARK-style `thinking: {type}` on other hosts)
		// (not where a provider profile already decided the toggle — Moonshot
		// 400s when both `thinking` and `reasoning_effort` are sent)
		if (um?.thinking?.type !== undefined && !zaiEndpoint && !(compat && Object.keys(compat).length > 0)) {
			rb.thinking = {
				type: um.thinking.type,
			};
		}

		// OpenRouter reasoning configuration (never on Z.AI, whose wire
		// takes `thinking` + `reasoning_effort` instead)
		if (um?.reasoning !== undefined && !zaiEndpoint) {
			const reasoningConfig: ReasoningConfig = um.reasoning as ReasoningConfig;
			if (reasoningConfig.enabled !== false) {
				const reasoningObj: Record<string, unknown> = {};
				const effort = reasoningConfig.effort;
				const maxTokensReasoning = reasoningConfig.max_tokens || 2000; // Default 2000 as per docs
				if (effort && effort !== "auto") {
					// Clamp like every other effort ("ultra" 400s on OpenRouter/xAI).
					const normalizedEffort = String(effort).trim().toLowerCase();
					reasoningObj.effort =
						normalizedEffort === "none"
							? "none"
							: clampEffort(normalizedEffort, OPENAI_COMPAT_WIRE_EFFORTS) ?? normalizedEffort;
				} else {
					// If auto or unspecified, use max_tokens (Anthropic-style fallback)
					reasoningObj.max_tokens = maxTokensReasoning;
				}
				if (reasoningConfig.exclude !== undefined) {
					reasoningObj.exclude = reasoningConfig.exclude;
				}
				rb.reasoning = reasoningObj;
			}
		}

		// stop
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		// tools
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			// Kimi/Moonshot accept only a strict JSON-Schema subset (hermes
			// sanitize_moonshot_tools); other providers get the schemas as-is.
			rb.tools = isMoonshotModel(um?.id)
				? toolConfig.tools.map((t) => ({
						...t,
						function: { ...t.function, parameters: sanitizeMoonshotToolParameters(t.function.parameters) },
					}))
				: toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			rb.tool_choice = toolConfig.tool_choice;
		}

		// Configure user-defined additional parameters
		if (um?.top_k !== undefined) {
			rb.top_k = um.top_k;
		}
		if (um?.min_p !== undefined) {
			rb.min_p = um.min_p;
		}
		if (um?.frequency_penalty !== undefined) {
			rb.frequency_penalty = um.frequency_penalty;
		}
		if (um?.presence_penalty !== undefined) {
			rb.presence_penalty = um.presence_penalty;
		}
		if (um?.repetition_penalty !== undefined) {
			rb.repetition_penalty = um.repetition_penalty;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			// Add all extra parameters directly to the request body
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					rb[key] = value;
				}
			}
		}

		return rb;
	}

	/** Per-response tool-call slot bookkeeping (see `resolveToolSlot`). */
	private _toolSlotByIndex = new Map<number, number>();
	private _toolSlotIds = new Map<number, string>();
	private _nextToolSlot = 0;
	private _lastToolSlot: number | undefined;
	/** OpenRouter reasoning_details merged by index across deltas. */
	private _reasoningDetails = new Map<string, Record<string, unknown>>();
	private _finishReason: string | undefined;

	/**
	 * Read and parse the streaming (SSE) response and report parts.
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
		this._toolSlotByIndex.clear();
		this._toolSlotIds.clear();
		this._nextToolSlot = 0;
		this._lastToolSlot = undefined;
		this._reasoningDetails.clear();
		this._finishReason = undefined;
		const modelId = this._modelId;
		logger.debug("openai.stream.start", { modelId });

		try {
			for await (const line of this.readStreamLines(responseBody, token)) {
				const data = CommonApi.sseData(line);
				if (!data) {
					continue;
				}
				logger.debug("openai.stream.chunk", { modelId, data });
				if (data === "[DONE]") {
					continue;
				}

				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(data);
				} catch (e) {
					console.error("[OpenAI Provider] Failed to parse SSE chunk:", e, "data:", data);
					logger.error("openai.stream.chunk.error", {
						modelId,
						error: e instanceof Error ? e.message : String(e),
						data,
					});
					continue;
				}
				// In-stream error object (OpenRouter, vLLM, Z.AI…): surface it
				// instead of ending with a silently truncated answer.
				if (parsed.error && !parsed.choices) {
					const err = parsed.error as Record<string, unknown> | string;
					const msg =
						typeof err === "string" ? err : typeof err.message === "string" ? err.message : JSON.stringify(err);
					const code = typeof err === "object" && err ? String(err.code ?? "") : "";
					throw new Error(`API stream error${code ? ` [${code}]` : ""}: ${msg}`);
				}
				await this.processDelta(parsed, progress);
			}
			// Streams that end without [DONE] / finish_reason must not lose
			// a fully-received tool call.
			await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
			this.flushReasoningDetails(progress);
			this.reportStopNotice(progress, this._finishReason);
			logger.debug("openai.stream.done", { modelId, finishReason: this._finishReason ?? "" });
		} catch (e) {
			console.error("[OpenAI Provider] Streaming response error:", e);
			logger.error("openai.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);
		}
	}

	/**
	 * Map a streamed tool-call delta onto a stable internal slot. Providers
	 * disagree on `index`: some omit it, some reuse index 0 for every
	 * parallel call (distinguished only by id), some repeat the id on every
	 * chunk. A new id always opens a new slot; id-less chunks continue the
	 * slot of their index (or the last slot when index is absent).
	 */
	private resolveToolSlot(tc: Record<string, unknown>): number {
		const id = typeof tc.id === "string" && tc.id ? tc.id : undefined;
		const pIdx = typeof tc.index === "number" ? tc.index : undefined;
		if (id) {
			for (const [slot, sid] of this._toolSlotIds) {
				if (sid === id) {
					this._lastToolSlot = slot;
					return slot;
				}
			}
			if (pIdx !== undefined) {
				const existing = this._toolSlotByIndex.get(pIdx);
				if (existing !== undefined && !this._toolSlotIds.has(existing)) {
					this._toolSlotIds.set(existing, id);
					this._lastToolSlot = existing;
					return existing;
				}
			}
			const slot = this._nextToolSlot++;
			this._toolSlotIds.set(slot, id);
			if (pIdx !== undefined) {
				this._toolSlotByIndex.set(pIdx, slot);
			}
			this._lastToolSlot = slot;
			return slot;
		}
		if (pIdx !== undefined) {
			let slot = this._toolSlotByIndex.get(pIdx);
			if (slot === undefined) {
				slot = this._nextToolSlot++;
				this._toolSlotByIndex.set(pIdx, slot);
			}
			this._lastToolSlot = slot;
			return slot;
		}
		if (this._lastToolSlot === undefined) {
			this._lastToolSlot = this._nextToolSlot++;
		}
		return this._lastToolSlot;
	}

	/** Merge one streamed OpenRouter reasoning_details entry into the accumulator. */
	private mergeReasoningDetail(detail: Record<string, unknown>, position: number): void {
		const key = `${typeof detail.index === "number" ? detail.index : position}:${String(detail.type ?? "")}`;
		const acc = this._reasoningDetails.get(key);
		if (!acc) {
			this._reasoningDetails.set(key, { ...detail });
			return;
		}
		for (const [k, v] of Object.entries(detail)) {
			if ((k === "text" || k === "summary") && typeof v === "string") {
				acc[k] = (typeof acc[k] === "string" ? (acc[k] as string) : "") + v;
			} else if (v !== undefined && v !== null && v !== "") {
				acc[k] = v;
			}
		}
	}

	/** Attach the merged reasoning_details to the thinking sequence for replay. */
	private flushReasoningDetails(progress: Progress<LanguageModelResponsePart2>): void {
		if (this._reasoningDetails.size === 0) {
			return;
		}
		const merged = Array.from(this._reasoningDetails.values());
		this._reasoningDetails.clear();
		this.reportThinkingMetadata(progress, { reasoning_details: merged });
	}

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param delta Parsed SSE chunk.
	 * @param progress Progress reporter for parts.
	 */
	private async processDelta(
		delta: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<boolean> {
		let emitted = false;

		// Usage chunk (arrives with stream_options.include_usage as the last
		// chunk with an empty choices array). Feeds the Copilot context
		// circle via the "usage" data part.
		if (delta.usage && typeof delta.usage === "object") {
			this._lastUsage = accumulateUsage(this._lastUsage, delta.usage as Partial<ApiUsage>);
		}

		const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
		if (!choice) {
			return false;
		}

		const deltaObj = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;

		// Process thinking content first (before regular text content)
		try {
			// OpenRouter reasoning_details: visible text comes from
			// reasoning.text / reasoning.summary; encrypted blocks are kept
			// only for replay (never shown as "[REDACTED]" noise).
			const maybeReasoningDetails = deltaObj?.reasoning_details ?? choice.reasoning_details;
			let hadDetailsText = false;
			if (Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
				(maybeReasoningDetails as Array<ReasoningDetail>).forEach((detail, position) => {
					if (!detail || typeof detail !== "object") {
						return;
					}
					this.mergeReasoningDetail(detail as unknown as Record<string, unknown>, position);
					let extractedText = "";
					if (detail.type === "reasoning.summary") {
						extractedText = (detail as ReasoningSummaryDetail).summary;
					} else if (detail.type === "reasoning.text") {
						extractedText = (detail as ReasoningTextDetail).text;
					}
					if (typeof extractedText === "string" && extractedText) {
						this.bufferThinkingContent(extractedText, progress);
						hadDetailsText = true;
						emitted = true;
					}
				});
			}

			// Plain reasoning text: the FIRST non-empty field wins — several
			// servers send the same text under both `reasoning` and
			// `reasoning_content`, which would otherwise be shown twice.
			if (!hadDetailsText) {
				const candidates = [
					deltaObj?.reasoning_content,
					deltaObj?.reasoning,
					deltaObj?.thinking,
					choice.thinking,
				];
				for (const candidate of candidates) {
					let text = "";
					if (typeof candidate === "string") {
						text = candidate;
					} else if (candidate && typeof candidate === "object") {
						const mt = candidate as Record<string, unknown>;
						text = typeof mt.text === "string" ? mt.text : typeof mt.content === "string" ? mt.content : "";
					}
					if (text) {
						this.bufferThinkingContent(text, progress);
						emitted = true;
						break;
					}
				}
			}
		} catch (e) {
			console.error("[customcopilot] Failed to process thinking/reasoning_details:", e);
		}

		// A refusal is the answer (hermes promotes it to content): without
		// this a refusal-only stream looked like an empty response.
		if (typeof deltaObj?.refusal === "string" && deltaObj.refusal) {
			this.reportEndThinking(progress);
			if (this.processTextContent(deltaObj.refusal, progress).emittedAny) {
				this._hasEmittedAssistantText = true;
				emitted = true;
			}
		}

		if (typeof deltaObj?.content === "string" && deltaObj.content) {
			const content = deltaObj.content;

			// Process XML think blocks or text content (mutually exclusive)
			const xmlRes = this.processXmlThinkBlocks(content, progress);
			if (xmlRes.emittedAny) {
				if (this._hasEmittedText) {
					this._hasEmittedAssistantText = true;
				}
				emitted = true;
			} else {
				// If there's an active thinking sequence, end it first
				this.reportEndThinking(progress);

				// Only process text content if no XML think blocks were emitted
				const res = this.processTextContent(content, progress);
				if (res.emittedAny) {
					this._hasEmittedAssistantText = true;
					emitted = true;
				}
			}
		}

		if (Array.isArray(deltaObj?.tool_calls) && deltaObj.tool_calls.length > 0) {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

			// SSEProcessor-like: if first tool call appears after text, emit a whitespace
			// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
			if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
				progress.report(new vscode.LanguageModelTextPart(" "));
				this._emittedBeginToolCallsHint = true;
			}

			for (const tc of toolCalls) {
				if (!tc || typeof tc !== "object") {
					continue;
				}
				const idx = this.resolveToolSlot(tc);
				// Ignore any further deltas for a slot we've already completed
				if (this._completedToolCallIndices.has(idx)) {
					continue;
				}
				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (typeof tc.id === "string" && tc.id) {
					buf.id = tc.id;
				}
				const func = tc.function as Record<string, unknown> | undefined;
				if (typeof func?.name === "string" && func.name) {
					buf.name = func.name;
				}
				const extraContent = tc.extra_content;
				if (extraContent && typeof extraContent === "object" && buf.id) {
					rememberGeminiExtraContent(buf.id, extraContent);
				}
				if (typeof func?.arguments === "string") {
					buf.args += func.arguments;
				} else if (func?.arguments && typeof func.arguments === "object") {
					// A few servers send arguments as an already-parsed object.
					buf.args = JSON.stringify(func.arguments);
				}
				this._toolCallBuffers.set(idx, buf);

				// Emit immediately once arguments become valid JSON to avoid perceived hanging
				await this.tryEmitBufferedToolCall(idx, progress);
			}
		}

		const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
		if (finish) {
			this._finishReason = finish;
		}
		if (finish === "tool_calls" || finish === "stop" || finish === "function_call") {
			// Emit any buffered calls; an unparseable call is dropped with a
			// log rather than failing the whole (already-streamed) response.
			await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
		}
		return emitted;
	}

	async *createMessage(
		model: CustomModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string,
		signal?: AbortSignal
	): AsyncGenerator<{ type: "text"; text: string }> {
		// Combine system prompt with first user message or as separate system message
		const openaiMessages = [...messages];
		if (systemPrompt) {
			openaiMessages.unshift({ role: "system", content: systemPrompt });
		}

		let requestBody: Record<string, unknown> = {
			model: model.id,
			messages: openaiMessages,
			stream: true,
		};
		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai", model.headers, model.userAgent);
		const networkInit = buildFetchNetworkInit(model.proxyUrl);

		const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

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
			throw new Error(`OpenAI API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from OpenAI API");
		}

		// Process the response
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
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === "[DONE]") {continue;}

					try {
						const parsed = JSON.parse(data);

						// OpenAI-compatible streaming response
						const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0];
						if (!choice) {continue;}

						const deltaObj = choice.delta as Record<string, unknown> | undefined;
						if (deltaObj?.content) {
							const content = String(deltaObj.content);
							yield { type: "text", text: content };
						}
						// Handle finish reason
						if (choice.finish_reason) {
							break;
						}
					} catch (e) {
						console.error("[OpenAI Provider] Failed to parse SSE chunk:", e, "data:", data);
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
