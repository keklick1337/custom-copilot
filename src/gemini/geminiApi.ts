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
	convertToolsToOpenAI,
	mapRole,
	tryParseJSONObject,
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
	thought?: string;
	createdAt: number;
}

function normalizeStringEffort(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** When thinking is on, raise maxOutputTokens to the API ceiling so thought
 * tokens don't starve the visible answer (mirrors hermes-agent's
 * GEMINI_DEFAULT_MAX_OUTPUT_TOKENS). */
const GEMINI_THINKING_MAX_OUTPUT_TOKENS = 65535;

export { buildGeminiGenerateContentUrl } from "./geminiUrls";
export class GeminiApi extends CommonApi<GeminiChatMessage, GeminiGenerateContentRequest> {
	constructor(
		modelId: string,
		private readonly toolCallMetaByCallId?: Map<string, GeminiToolCallMeta>
	) {
		super(modelId);
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): GeminiChatMessage[] {
		// Fresh conversion state per request (adapters are reused across turns).
		this.resetRequestState();
		const out: GeminiChatMessage[] = [];
		const toolNameByCallId = new Map<string, string>();

		const extractMessageParts = (m: LanguageModelChatRequestMessage) => {
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [];
			const toolResults: Array<{ callId: string; outputText: string }> = [];

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
					toolResults.push({ callId, outputText });
				}
			}

			return { text: textParts.join("").trim(), imageParts, toolCalls, toolResults };
		};

		const toolResultToFunctionResponsePart = (
			callId: string,
			outputText: string,
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

			const parsed = tryParseJSONObject(outputText);
			const responseValue: Record<string, unknown> = parsed.ok ? parsed.value : { output: outputText };
			return { functionResponse: { name, response: responseValue } };
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
						const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
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

				const fcPart: Record<string, unknown> = {
					functionCall: { name, args: tc.args },
				};
				const meta = this.toolCallMetaByCallId?.get(callId);
				if (meta?.thoughtSignature) {
					fcPart.thoughtSignature = meta.thoughtSignature;
				}
				if (meta?.thought) {
					fcPart.thought = meta.thought;
				}
				parts.push(fcPart as GeminiPart);
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
						const part = toolResultToFunctionResponsePart(tr.callId, tr.outputText);
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
							respParts.push({ functionResponse: { name: c.name, response: { output: "" } } });
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

		// maxOutputTokens. When thinking is enabled, thought tokens bill
		// against maxOutputTokens too — a small cap can be consumed entirely
		// by reasoning (finishReason=MAX_TOKENS, empty answer). Raise the
		// ceiling to the API maximum in that case (ported from hermes-agent
		// `_effective_gemini_max_output_tokens`).
		const maxOutput =
			um?.max_completion_tokens !== undefined
				? um.max_completion_tokens
				: um?.max_tokens !== undefined
					? um.max_tokens
					: undefined;
		const geminiThinkingActive =
			um?.enable_thinking === true ||
			um?.thinking?.type === "enabled" ||
			(typeof um?.reasoning_effort === "string" && um.reasoning_effort.trim() !== "" && um.reasoning_effort !== "none");
		if (maxOutput !== undefined) {
			generationConfig.maxOutputTokens =
				geminiThinkingActive && parsedModelIdForThinking.toLowerCase().startsWith("gemini")
					? Math.max(maxOutput, GEMINI_THINKING_MAX_OUTPUT_TOKENS)
					: maxOutput;
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
		// - disabling sets thinkingBudget: 0 on families that document it
		//   (includeThoughts:false alone still bills thought tokens);
		// - Gemini 3 takes thinkingLevel ("low"/"medium"/"high"), clamped to
		//   what each family accepts.
		const normalizedModelId = parsedModelIdForThinking.toLowerCase();
		const isGeminiModel = normalizedModelId.startsWith("gemini");
		const zaiThinkingEnabled = um?.thinking?.type === "enabled";
		const thinkingExtraSet =
			um?.extra?.generationConfig &&
			typeof um.extra.generationConfig === "object" &&
			"thinkingConfig" in um.extra.generationConfig;
		if (isGeminiModel && !thinkingExtraSet) {
			if (um?.enable_thinking === false || um?.thinking?.type === "disabled") {
				// Actually disable thinking, not just hide the thoughts.
				const tc: Record<string, unknown> = { includeThoughts: false };
				if (
					normalizedModelId === "gemini-flash-latest" ||
					normalizedModelId.startsWith("gemini-2.5-") ||
					normalizedModelId.startsWith("gemini-3")
				) {
					tc.thinkingBudget = 0;
				}
				generationConfig.thinkingConfig = tc;
			} else if (
				um?.enable_thinking === true ||
				zaiThinkingEnabled ||
				(typeof um?.reasoning_effort === "string" && normalizeStringEffort(um.reasoning_effort) !== "" && um.reasoning_effort !== "none")
			) {
				const tc: Record<string, unknown> = { includeThoughts: true };
				if (um?.thinking_budget !== undefined) {
					tc.thinkingBudget = um.thinking_budget;
				}
				// Gemini 3 documents thinkingLevel; 2.5 takes only thinkingBudget.
				if (normalizedModelId.startsWith("gemini-3")) {
					const effort = normalizeStringEffort(um?.reasoning_effort);
					if (normalizedModelId.includes("flash")) {
						tc.thinkingLevel = effort === "low" || effort === "minimal" ? "low" : effort === "medium" ? "medium" : "high";
					} else if (normalizedModelId.includes("pro")) {
						// Pro is stricter: low/high only.
						tc.thinkingLevel = effort === "low" || effort === "minimal" ? "low" : "high";
					}
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
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		let textSoFar = "";
		const toolCallKeyToId = new Map<string, string>();
		let pendingThoughtSoFar = "";
		let pendingThoughtSummarySoFar = "";
		let pendingThoughtSignature = "";

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
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					logger.debug("gemini.stream.chunk", { modelId, data });
					if (!data || data === "[DONE]") {
						continue;
					}

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

					const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
					const cand = candidates.length > 0 ? candidates[0] : null;
					const parts = Array.isArray(cand?.content?.parts) ? cand?.content?.parts : [];

					// usageMetadata rides on every chunk; the final one is
					// authoritative (promptTokenCount + candidatesTokenCount +
					// thoughtsTokenCount).
					const um = (payload as { usageMetadata?: Record<string, unknown> }).usageMetadata;
					if (um) {
						this._lastUsage = accumulateUsage(this._lastUsage, {
							prompt_tokens: typeof um.promptTokenCount === "number" ? um.promptTokenCount : undefined,
							completion_tokens:
								(typeof um.candidatesTokenCount === "number" ? um.candidatesTokenCount : 0) +
								(typeof um.thoughtsTokenCount === "number" ? um.thoughtsTokenCount : 0),
							total_tokens: typeof um.totalTokenCount === "number" ? um.totalTokenCount : undefined,
							prompt_tokens_details:
								typeof um.cachedContentTokenCount === "number" ? { cached_tokens: um.cachedContentTokenCount } : undefined,
						});
					}

					for (const p of parts) {
						const fc = p?.functionCall;
						if (!fc || typeof fc !== "object") {
							// Standalone thought (Gemini "thought summaries" or 2025 API: thought comes in separate part)
							const maybeThought = p && typeof p === "object" ? (p as unknown as Record<string, unknown>) : null;
							const thoughtSummaryText =
								maybeThought && maybeThought.thought === true && typeof (p as GeminiPart).text === "string"
									? String((p as GeminiPart).text)
									: "";
							const thought = maybeThought && typeof maybeThought.thought === "string" ? maybeThought.thought : "";
							const thoughtSigRaw =
								maybeThought && typeof maybeThought.thoughtSignature === "string"
									? maybeThought.thoughtSignature
									: maybeThought && typeof maybeThought.thought_signature === "string"
										? maybeThought.thought_signature
										: "";
							if (thoughtSummaryText) {
								let delta = "";
								if (thoughtSummaryText.startsWith(pendingThoughtSummarySoFar)) {
									delta = thoughtSummaryText.slice(pendingThoughtSummarySoFar.length);
									pendingThoughtSummarySoFar = thoughtSummaryText;
								} else if (pendingThoughtSummarySoFar.startsWith(thoughtSummaryText)) {
									delta = "";
								} else {
									delta = thoughtSummaryText;
									pendingThoughtSummarySoFar += thoughtSummaryText;
								}
								if (delta) {
									this.bufferThinkingContent(delta, progress);
								}
							}
							if (thought) {
								let delta = "";
								if (thought.startsWith(pendingThoughtSoFar)) {
									delta = thought.slice(pendingThoughtSoFar.length);
									pendingThoughtSoFar = thought;
								} else if (pendingThoughtSoFar.startsWith(thought)) {
									delta = "";
								} else {
									delta = thought;
									pendingThoughtSoFar += thought;
								}

								if (delta) {
									this.bufferThinkingContent(delta, progress);
								}
							}
							if (thoughtSigRaw) {
								pendingThoughtSignature = thoughtSigRaw;
							}
							continue;
						}
						const name =
							typeof (fc as { name?: unknown }).name === "string" ? String((fc as { name: string }).name).trim() : "";
						if (!name) {
							continue;
						}
						const argsRaw = (fc as { args?: unknown }).args;
						const argsObj =
							argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
								? (argsRaw as Record<string, unknown>)
								: {};
						const key = `${name}\n${JSON.stringify(argsObj)}`;

						const pObj = p && typeof p === "object" ? (p as unknown as Record<string, unknown>) : null;
						const fcObj = fc && typeof fc === "object" ? (fc as unknown as Record<string, unknown>) : null;
						const thoughtSigRaw =
							(pObj && typeof pObj.thoughtSignature === "string" ? pObj.thoughtSignature : "") ||
							(pObj && typeof pObj.thought_signature === "string" ? pObj.thought_signature : "") ||
							(fcObj && typeof fcObj.thoughtSignature === "string" ? fcObj.thoughtSignature : "") ||
							(fcObj && typeof fcObj.thought_signature === "string" ? fcObj.thought_signature : "") ||
							pendingThoughtSignature;
						const thoughtRaw =
							(pObj && typeof pObj.thought === "string" ? pObj.thought : "") ||
							(fcObj && typeof fcObj.thought === "string" ? fcObj.thought : "") ||
							pendingThoughtSoFar;

						if (thoughtRaw) {
							let delta = "";
							if (thoughtRaw.startsWith(pendingThoughtSoFar)) {
								delta = thoughtRaw.slice(pendingThoughtSoFar.length);
								pendingThoughtSoFar = thoughtRaw;
							} else if (pendingThoughtSoFar.startsWith(thoughtRaw)) {
								delta = "";
							} else {
								delta = thoughtRaw;
								pendingThoughtSoFar += thoughtRaw;
							}

							if (delta) {
								this.bufferThinkingContent(delta, progress);
							}
						}

						let id = toolCallKeyToId.get(key);
						const isNew = !id;
						if (!id) {
							id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
							toolCallKeyToId.set(key, id);
						}

						// Cache thoughtSignature/thought for Gemini thinking models (2025 API requirement)
						if (this.toolCallMetaByCallId) {
							this.toolCallMetaByCallId.set(id, {
								name,
								thoughtSignature: thoughtSigRaw || undefined,
								thought: thoughtRaw || undefined,
								createdAt: Date.now(),
							});
							// Basic pruning to avoid unbounded growth.
							const maxEntries = 2000;
							const pruneTo = 1500;
							if (this.toolCallMetaByCallId.size > maxEntries) {
								while (this.toolCallMetaByCallId.size > pruneTo) {
									const first = this.toolCallMetaByCallId.keys().next().value as string | undefined;
									if (!first) {
										break;
									}
									this.toolCallMetaByCallId.delete(first);
								}
							}
						}

						if (isNew) {
							this.reportEndThinking(progress);
							pendingThoughtSoFar = "";
							pendingThoughtSummarySoFar = "";
							pendingThoughtSignature = "";
							if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
								progress.report(new vscode.LanguageModelTextPart(" "));
								this._emittedBeginToolCallsHint = true;
							}
							progress.report(new vscode.LanguageModelToolCallPart(id, name, argsObj));
						}
					}

					const textJoined = parts
						.map((p) => {
							if (!p || typeof p !== "object") {
								return "";
							}
							const obj = p as unknown as Record<string, unknown>;
							// Thought summary text comes through as `text` with `thought: true`
							if (obj.thought === true) {
								return "";
							}
							return typeof (p as GeminiPart).text === "string" ? String((p as GeminiPart).text) : "";
						})
						.filter(Boolean)
						.join("");

					if (textJoined) {
						let delta = "";
						if (textJoined.startsWith(textSoFar)) {
							delta = textJoined.slice(textSoFar.length);
							textSoFar = textJoined;
						} else if (textSoFar.startsWith(textJoined)) {
							delta = "";
						} else {
							delta = textJoined;
							textSoFar += textJoined;
						}

						if (delta) {
							this.reportEndThinking(progress);
							pendingThoughtSoFar = "";
							pendingThoughtSummarySoFar = "";
							pendingThoughtSignature = "";
							progress.report(new vscode.LanguageModelTextPart(delta));
							this._hasEmittedAssistantText = true;
						}
					}
				}
			}
			logger.debug("gemini.stream.done", { modelId });
		} catch (e) {
			console.error("[Gemini Provider] Streaming response error:", e);
			logger.error("gemini.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			reader.releaseLock();
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
