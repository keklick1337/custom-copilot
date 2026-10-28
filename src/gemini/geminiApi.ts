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

import { CommonApi, accumulateUsage } from "../commonApi";
import { openaiToolsToGeminiFunctionDeclarations, openaiToolChoiceToGeminiToolConfig } from "./geminiTools";
import { buildGeminiGenerateContentUrl } from "./geminiUrls";
import { buildFetchNetworkInit, proxyFetch } from "../network";
import { logger } from "../logger";

import {
	isImageMimeType,
	isToolResultPart,
	collectToolResultText,
	collectToolResultImages,
	convertToolsToOpenAI,
	mapRole,
	tryParseJSONObject,
	resolveThinkingEnabled,
} from "../utils";

import type {
	GeminiGenerateContentRequest,
	GeminiGenerateContentResponse,
	GeminiPart,
} from "./geminiTypes";

export interface GeminiChatMessage {
	role: "user" | "model" | "system";
	parts: GeminiPart[];
}

export interface GeminiToolCallMeta {
	name: string;
	thoughtSignature?: string;
	createdAt: number;
}

function normalizeStringEffort(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** When thinking is on, raise maxOutputTokens to the API ceiling so thought
 * tokens don't starve the visible answer (mirrors hermes-agent's
 * GEMINI_DEFAULT_MAX_OUTPUT_TOKENS). */
const GEMINI_THINKING_MAX_OUTPUT_TOKENS = 65535;

/** Google's documented placeholder for a functionCall whose signature is unknown. */
const GEMINI_SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export { buildGeminiGenerateContentUrl } from "./geminiUrls";

/** Placeholder model turn between a functionResponse turn and human text (gemini-cli / hermes). */
const GEMINI_INTERRUPTED_PLACEHOLDER = "[The previous response was interrupted before it completed.]";

function hasFunctionResponse(c: { parts: GeminiPart[] }): boolean {
	return c.parts.some((p) => !!p && typeof p === "object" && "functionResponse" in p);
}

/**
 * Gemini's alternation contract (hermes `_merge_alternating`): adjacent
 * same-role contents merge (else 400 "multiturn requests must alternate"),
 * EXCEPT a functionResponse-only user turn is never fused with human text
 * (Gemini 3 would read the text as part of the tool result) — a placeholder
 * model turn is interposed instead.
 */
export function mergeGeminiAlternating<T extends { role: string; parts: GeminiPart[] }>(contents: T[]): T[] {
	const merged: T[] = [];
	for (const content of contents) {
		const prev = merged[merged.length - 1];
		let sameRole = prev !== undefined && prev.role === content.role;
		if (sameRole && content.role === "user" && hasFunctionResponse(prev) !== hasFunctionResponse(content)) {
			sameRole = false;
			merged.push({ role: "model", parts: [{ text: GEMINI_INTERRUPTED_PLACEHOLDER }] } as T);
		}
		if (sameRole) {
			prev.parts = [...prev.parts, ...content.parts];
		} else {
			merged.push({ ...content, parts: [...content.parts] });
		}
	}
	return merged;
}
export class GeminiApi extends CommonApi<GeminiChatMessage, GeminiGenerateContentRequest> {
	constructor(
		modelId: string,
		private readonly toolCallMetaByCallId?: Map<string, GeminiToolCallMeta>
	) {
		super(modelId);
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: MessageConversionConfig
	): GeminiChatMessage[] {
		// Fresh conversion state per request (adapters are reused across turns).
		this.resetRequestState();
		const out: GeminiChatMessage[] = [];
		const toolNameByCallId = new Map<string, string>();

		const extractMessageParts = (m: LanguageModelChatRequestMessage) => {
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
			const toolResults: Array<{ callId: string; outputText: string; images: vscode.LanguageModelDataPart[] }> = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const callId = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const args = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
					toolCalls.push({ callId, name: part.name, args });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const outputText = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					const images = collectToolResultImages(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, outputText, images });
				}
			}

			return { text: textParts.join("").trim(), imageParts, toolCalls, toolResults };
		};

		// Gemini 3+ pairs calls/responses by id and accepts multimodal tool
		// output; 2.x rejects both fields (hermes gemini_native_adapter).
		const isGemini3 = /gemini-[3-9]/i.test(this._modelId);

		const toolResultToFunctionResponsePart = (
			callId: string,
			outputText: string,
			images: vscode.LanguageModelDataPart[] = [],
			fallbackName = ""
		): GeminiPart | null => {
			if (!callId) {
				return null;
			}
			const meta = this.toolCallMetaByCallId?.get(callId);
			const name = toolNameByCallId.get(callId) ?? meta?.name ?? fallbackName;
			if (!name) {
				return null;
			}

			// JSON containing $ref is sent as text (Gemini resolves refs and 400s).
			const parsed = outputText.includes("$ref") ? { ok: false as const } : tryParseJSONObject(outputText);
			const responseValue: Record<string, unknown> = parsed.ok ? parsed.value : { output: outputText };
			const functionResponse: NonNullable<GeminiPart["functionResponse"]> = { name, response: responseValue };
			if (isGemini3) {
				functionResponse.id = callId;
				if (images.length > 0) {
					functionResponse.parts = images.map((img) => ({
						inlineData: { mimeType: img.mimeType, data: Buffer.from(img.data).toString("base64") },
					}));
				}
			}
			return { functionResponse };
		};

		const isToolResultOnly = (extracted: {
			text: string;
			imageParts: vscode.LanguageModelDataPart[];
			toolCalls: Array<unknown>;
			toolResults: Array<unknown>;
		}): boolean => {
			return Boolean(
				extracted.toolResults.length > 0 &&
					!extracted.text &&
					extracted.imageParts.length === 0 &&
					extracted.toolCalls.length === 0
			);
		};

		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const role = mapRole(m);
			const extracted = extractMessageParts(m);

			// Best-effort: group consecutive tool results into a single user turn.
			if (isToolResultOnly(extracted)) {
				const respParts: GeminiPart[] = [];
				let j = i;
				while (j < messages.length) {
					const ex2 = extractMessageParts(messages[j]);
					if (!isToolResultOnly(ex2)) {
						break;
					}
					for (const tr of ex2.toolResults) {
						const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText, tr.images);
						if (part) {
							respParts.push(part);
						}
					}
					j++;
				}
				if (respParts.length > 0) {
					out.push({ role: "user", parts: respParts });
				}
				i = j - 1;
				continue;
			}

			if (role === "system") {
				if (extracted.text) {
					out.push({ role: "system", parts: [{ text: extracted.text }] });
				}
				continue;
			}

			if (role === "user") {
				// Tool results that share a message with text/images: answer the
				// calls in their own functionResponse turn (mergeGeminiAlternating
				// keeps it apart from the human text turn).
				const respParts = extracted.toolResults
					.map((tr) => toolResultToFunctionResponsePart(tr.callId, tr.outputText, tr.images))
					.filter((p): p is GeminiPart => p !== null);
				if (respParts.length > 0) {
					out.push({ role: "user", parts: respParts });
				}
				const parts: GeminiPart[] = [];
				if (extracted.text) {
					parts.push({ text: extracted.text });
				}
				for (const img of extracted.imageParts) {
					const data = Buffer.from(img.data).toString("base64");
					parts.push({ inlineData: { mimeType: img.mimeType, data } });
				}
				if (parts.length > 0) {
					out.push({ role: "user", parts });
				}
				continue;
			}

			// assistant -> Gemini "model"
			const parts: GeminiPart[] = [];
			if (extracted.text) {
				parts.push({ text: extracted.text });
			}

			const callOrder: Array<{ callId: string; name: string }> = [];
			for (const tc of extracted.toolCalls) {
				const callId = tc.callId;
				const name = tc.name;
				toolNameByCallId.set(callId, name);
				callOrder.push({ callId, name });

				const functionCall: NonNullable<GeminiPart["functionCall"]> = { name, args: tc.args };
				if (isGemini3) {
					functionCall.id = callId;
				}
				// Thinking models require the thoughtSignature captured with the
				// call. When it is unknown (call from another provider, or the
				// in-memory cache was lost on reload) use Google's documented
				// skip sentinel instead of failing with a 400 (hermes
				// `_SKIP_SIGNATURE`). `thought` is a boolean flag in the API
				// schema — never replay the thought TEXT on a call part.
				const meta = this.toolCallMetaByCallId?.get(callId);
				parts.push({
					functionCall,
					thoughtSignature: meta?.thoughtSignature || GEMINI_SKIP_THOUGHT_SIGNATURE,
				});
			}

			if (parts.length > 0) {
				out.push({ role: "model", parts });
			}

			// Gemini requires that tool responses are provided as a single "user" turn
			// containing the same number of functionResponse parts as the preceding model's functionCall parts.
			if (callOrder.length > 0) {
				const responsesByCallId = new Map<string, GeminiPart>();
				let j = i + 1;
				while (j < messages.length) {
					const ex2 = extractMessageParts(messages[j]);
					if (!isToolResultOnly(ex2)) {
						break;
					}
					for (const tr of ex2.toolResults) {
						const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText, tr.images);
						if (part) {
							responsesByCallId.set(tr.callId, part);
						}
					}
					j++;
				}

				if (responsesByCallId.size > 0) {
					const respParts: GeminiPart[] = [];
					for (const c of callOrder) {
						const found = responsesByCallId.get(c.callId);
						if (found) {
							respParts.push(found);
						} else {
							respParts.push({
								functionResponse: {
									...(isGemini3 ? { id: c.callId } : {}),
									name: c.name,
									response: { output: "(no output — the tool call was cancelled)" },
								},
							});
						}
					}
					out.push({ role: "user", parts: respParts });
					i = j - 1;
				}
			}
		}

		return out;
	}

	prepareRequestBody(
		rb: GeminiGenerateContentRequest,
		um: CustomModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): GeminiGenerateContentRequest {
		// Base model id used for model-family heuristics (thinkingConfig etc.);
		// provider.ts strips any vendor/index prefix, here we strip a config id.
		const parsedModelIdForThinking = (um?.id ?? this._modelId ?? "").split("::")[0];
		const generationConfig: Record<string, unknown> = {
			...(rb.generationConfig && typeof rb.generationConfig === "object"
				? (rb.generationConfig as Record<string, unknown>)
				: {}),
		};

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			generationConfig.temperature = um.temperature;
		}

		// topP/topK
		if (um?.top_p !== undefined && um.top_p !== null) {
			generationConfig.topP = um.top_p;
		}
		if (um?.top_k !== undefined && um.top_k !== null) {
			generationConfig.topK = um.top_k;
		}

		// Thinking preference (hermes `_build_gemini_thinking_config`).
		// Bare id: strip "models/" and relay/vendor prefixes ("google/gemini-…").
		const lowerModelId = parsedModelIdForThinking.toLowerCase().replace(/^models\//, "");
		const normalizedModelId = lowerModelId.slice(lowerModelId.lastIndexOf("/") + 1);
		const isGeminiModel = normalizedModelId.startsWith("gemini");
		const thinkingEnabled = resolveThinkingEnabled(um);
		const effort = normalizeStringEffort(um?.reasoning_effort);
		const geminiThinkingActive =
			thinkingEnabled === true || (thinkingEnabled === undefined && effort !== "" && effort !== "none");

		// maxOutputTokens. Thought tokens bill against maxOutputTokens too —
		// a small cap can be consumed entirely by reasoning (finishReason=
		// MAX_TOKENS, empty answer). The ceiling is raised to 65535 only for
		// thinking-capable families (2.5+) with thinking on — older models
		// (2.0 / 1.5, 8192 limit) reject larger values, so an unset cap stays
		// unset (hermes `_effective_gemini_max_output_tokens`).
		const maxOutput =
			um?.max_completion_tokens !== undefined
				? um.max_completion_tokens
				: um?.max_tokens !== undefined
					? um.max_tokens
					: undefined;
		const thinkingFamily = /^gemini-(2\.5|[3-9])|^gemini-(flash|pro)-latest/.test(normalizedModelId);
		if (isGeminiModel && thinkingFamily && geminiThinkingActive) {
			generationConfig.maxOutputTokens = Math.max(maxOutput ?? 0, GEMINI_THINKING_MAX_OUTPUT_TOKENS);
		} else if (maxOutput !== undefined && maxOutput > 0) {
			generationConfig.maxOutputTokens = maxOutput;
		}

		// stop sequences
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" && mo.stop) {
				generationConfig.stopSequences = [mo.stop];
			} else if (Array.isArray(mo.stop)) {
				generationConfig.stopSequences = mo.stop.filter((s) => typeof s === "string" && s);
			}
		}

		// penalties
		if (um?.presence_penalty !== undefined) {
			generationConfig.presencePenalty = um.presence_penalty;
		}
		if (um?.frequency_penalty !== undefined) {
			generationConfig.frequencyPenalty = um.frequency_penalty;
		}

		// Map the generic thinking toggles to Gemini's thinkingConfig
		// (ported from hermes-agent `_build_gemini_thinking_config`):
		// - thinkingConfig is a GEMINI-ONLY field — Gemma/PaLM models on the
		//   same provider 400 on it even as {"includeThoughts": false}, so it
		//   is omitted entirely for non-gemini model ids (hermes #17426);
		// - disabling bounds thinking as low as each family allows
		//   (includeThoughts:false alone still bills thought tokens):
		//   2.5 → thinkingBudget 0, 3+ → thinkingLevel "low";
		// - 2.5 takes only includeThoughts (+ an explicit user budget);
		// - Gemini 3 takes thinkingLevel — never together with a budget.
		const thinkingExtraSet =
			um?.extra?.generationConfig &&
			typeof um.extra.generationConfig === "object" &&
			"thinkingConfig" in um.extra.generationConfig;
		if (isGeminiModel && !thinkingExtraSet) {
			const isGemini3 = /^gemini-[3-9]/.test(normalizedModelId);
			if (thinkingEnabled === false || (thinkingEnabled === undefined && effort === "none")) {
				// Actually disable thinking, not just hide the thoughts.
				// 2.5 documents thinkingBudget:0 as the off switch; Gemini 3+
				// deprecated the budget (Gemini 4 always thinks and 400s on it)
				// in favour of thinkingLevel, whose lowest universal level is
				// "low" (hermes #91927).
				const tc: Record<string, unknown> = { includeThoughts: false };
				if (isGemini3) {
					tc.thinkingLevel = "low";
				} else if (normalizedModelId === "gemini-flash-latest" || normalizedModelId.startsWith("gemini-2.5-")) {
					tc.thinkingBudget = 0;
				}
				generationConfig.thinkingConfig = tc;
			} else if (geminiThinkingActive) {
				const tc: Record<string, unknown> = { includeThoughts: true };
				if (isGemini3 && (effort || um?.thinking_budget === undefined)) {
					const strong = effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultra";
					if (normalizedModelId.includes("pro")) {
						// Pro is stricter: low/high only.
						tc.thinkingLevel = strong ? "high" : "low";
					} else {
						tc.thinkingLevel = effort === "minimal" || effort === "low" ? "low" : strong ? "high" : "medium";
					}
				} else if (um?.thinking_budget !== undefined) {
					tc.thinkingBudget = um.thinking_budget;
				}
				generationConfig.thinkingConfig = tc;
			}
		}

		if (Object.keys(generationConfig).length > 0) {
			rb.generationConfig = generationConfig;
		}

		// tools/toolConfig (from VS Code tools + toolMode)
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools && toolConfig.tools.length > 0) {
			const decls = openaiToolsToGeminiFunctionDeclarations(toolConfig.tools);
			if (decls.length > 0) {
				rb.tools = [{ functionDeclarations: decls }];
				const tc = openaiToolChoiceToGeminiToolConfig(toolConfig.tool_choice);
				if (tc) {
					rb.toolConfig = tc;
				}
			}
		}

		// extra parameters
		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					rb[key] = value;
				}
			}
		}

		return rb;
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this.resetRequestState();
		const modelId = this._modelId;
		logger.debug("gemini.stream.start", { modelId });

		// streamGenerateContent?alt=sse chunks are INCREMENTAL: every text /
		// thought part is new content and is emitted as-is. (A previous
		// "cumulative prefix" heuristic dropped real deltas that happened to
		// be a prefix of the text so far, e.g. a repeated "*" or "\n".)
		const seenToolCallKeys = new Set<string>();
		let pendingThoughtSignature = "";
		let finishReason: string | undefined;

		try {
			for await (const line of this.readStreamLines(responseBody, token)) {
				const data = CommonApi.sseData(line);
				if (!data || data === "[DONE]") {
					continue;
				}
				logger.debug("gemini.stream.chunk", { modelId, data });

				let payload: GeminiGenerateContentResponse | null = null;
				try {
					payload = JSON.parse(data) as GeminiGenerateContentResponse;
				} catch (e) {
					console.error("[Gemini Provider] Failed to parse streaming chunk:", e, "data:", data);
					logger.error("gemini.stream.chunk.error", {
						modelId,
						error: e instanceof Error ? e.message : String(e),
						data,
					});
					continue;
				}
				if (!payload) {
					continue;
				}

				// In-stream error / blocked prompt: surface instead of an empty reply.
				const streamError = (payload as { error?: { message?: string; status?: string } }).error;
				if (streamError) {
					throw new Error(`Gemini stream error: ${streamError.message ?? streamError.status ?? JSON.stringify(streamError)}`);
				}
				const blockReason = (payload as { promptFeedback?: { blockReason?: string } }).promptFeedback?.blockReason;
				if (blockReason) {
					throw new Error(`Gemini blocked the prompt (${blockReason}).`);
				}

				const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
				const cand = candidates.length > 0 ? candidates[0] : null;
				const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
				const fr = cand?.finishReason ?? cand?.finish_reason;
				if (typeof fr === "string" && fr) {
					finishReason = fr;
				}

				// usageMetadata rides on every chunk; the final one is
				// authoritative (promptTokenCount + candidatesTokenCount +
				// thoughtsTokenCount).
				const um = (payload as { usageMetadata?: Record<string, unknown> }).usageMetadata;
				if (um) {
					const thoughts = typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0;
					this._lastUsage = accumulateUsage(this._lastUsage, {
						prompt_tokens: typeof um.promptTokenCount === "number" ? um.promptTokenCount : undefined,
						completion_tokens: (typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0) + thoughts,
						total_tokens: typeof um.totalTokenCount === "number" ? um.totalTokenCount : undefined,
						prompt_tokens_details:
							typeof um.cachedContentTokenCount === "number" ? { cached_tokens: um.cachedContentTokenCount } : undefined,
						completion_tokens_details: thoughts > 0 ? { reasoning_tokens: thoughts } : undefined,
					});
				}

				for (const p of parts) {
					if (!p || typeof p !== "object") {
						continue;
					}
					const pObj = p as unknown as Record<string, unknown>;
					const sig =
						(typeof pObj.thoughtSignature === "string" ? pObj.thoughtSignature : "") ||
						(typeof pObj.thought_signature === "string" ? pObj.thought_signature : "");
					const fc = p.functionCall;

					if (!fc || typeof fc !== "object") {
						if (sig) {
							pendingThoughtSignature = sig;
						}
						const text = typeof p.text === "string" ? p.text : "";
						if (!text) {
							continue;
						}
						if (p.thought === true) {
							// Thought summary part.
							this.bufferThinkingContent(text, progress);
						} else {
							this.reportEndThinking(progress);
							progress.report(new vscode.LanguageModelTextPart(text));
							this._hasEmittedAssistantText = true;
						}
						continue;
					}

					const name = typeof fc.name === "string" ? fc.name.trim() : "";
					if (!name) {
						continue;
					}
					const argsObj =
						fc.args && typeof fc.args === "object" && !Array.isArray(fc.args) ? (fc.args as Record<string, unknown>) : {};
					const fcId = typeof fc.id === "string" && fc.id ? fc.id : "";
					// Some gateways resend a call on later events: dedupe by id
					// (Gemini 3) or by name+args.
					const key = fcId || `${name}\n${JSON.stringify(argsObj)}`;
					if (seenToolCallKeys.has(key)) {
						continue;
					}
					seenToolCallKeys.add(key);
					const id = fcId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

					// Cache the thoughtSignature (required when replaying calls to
					// thinking models). Signature may ride on the call part itself
					// or on a preceding thought part.
					const thoughtSignature = sig || pendingThoughtSignature;
					pendingThoughtSignature = "";
					if (this.toolCallMetaByCallId) {
						this.toolCallMetaByCallId.set(id, {
							name,
							thoughtSignature: thoughtSignature || undefined,
							createdAt: Date.now(),
						});
						// Basic pruning to avoid unbounded growth.
						if (this.toolCallMetaByCallId.size > 2000) {
							while (this.toolCallMetaByCallId.size > 1500) {
								const first = this.toolCallMetaByCallId.keys().next().value as string | undefined;
								if (!first) {
									break;
								}
								this.toolCallMetaByCallId.delete(first);
							}
						}
					}

					this.reportEndThinking(progress);
					if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
						progress.report(new vscode.LanguageModelTextPart(" "));
						this._emittedBeginToolCallsHint = true;
					}
					progress.report(new vscode.LanguageModelToolCallPart(id, name, argsObj));
				}
			}
			const reason = (finishReason ?? "").toUpperCase();
			if (reason === "MALFORMED_FUNCTION_CALL" || reason === "UNEXPECTED_TOOL_CALL") {
				this.reportEndThinking(progress);
				progress.report(
					new vscode.LanguageModelTextPart(
						`${this._hasEmittedAssistantText ? "\n\n" : ""}⚠️ Gemini produced an invalid tool call (${finishReason}). Please retry.`
					)
				);
			} else {
				this.reportStopNotice(progress, reason === "MAX_TOKENS" ? "length" : reason.toLowerCase());
			}
			logger.debug("gemini.stream.done", { modelId, finishReason: finishReason ?? "" });
		} catch (e) {
			console.error("[Gemini Provider] Streaming response error:", e);
			logger.error("gemini.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			this.reportEndThinking(progress);
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
		// Used by the git-commit generator (non-chat consumer). Simple text
		// generation over the Gemini native wire with proxy support.
		const contents = messages.map((m) => ({
			role: m.role === "assistant" ? "model" : "user",
			parts: [{ text: m.content }],
		}));
		const requestBody: Record<string, unknown> = { contents };
		if (systemPrompt) {
			requestBody.systemInstruction = { role: "user", parts: [{ text: systemPrompt }] };
		}

		const url = buildGeminiGenerateContentUrl(baseUrl, model.id, false);
		if (!url) {
			throw new Error("Invalid Gemini base URL configuration.");
		}
		const headers = CommonApi.prepareHeaders(apiKey, "gemini", model.headers, model.userAgent);
		const networkInit = buildFetchNetworkInit(model.proxyUrl);

		const response = await proxyFetch(url, {
			...networkInit,
			...(signal ? { signal } : {}),
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Gemini API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}
		const parsed = (await response.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		const text = (parsed.candidates?.[0]?.content?.parts ?? [])
			.map((p) => (typeof p.text === "string" ? p.text : ""))
			.join("");
		if (text) {
			yield { type: "text", text };
		}
	}
}
