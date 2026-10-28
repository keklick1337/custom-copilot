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

import type {
	AnthropicCacheControl,
	AnthropicMessage,
	AnthropicRequestBody,
	AnthropicContentBlock,
	AnthropicTextBlock,
	AnthropicToolUseBlock,
	AnthropicToolResultBlock,
	AnthropicStreamChunk,
} from "./anthropicTypes";

import {
	isImageMimeType,
	isToolResultPart,
	collectToolResultText,
	collectToolResultImages,
	convertToolsToOpenAI,
	mapRole,
	resolveThinkingEnabled,
} from "../utils";
import { anthropicThinkingBudget, glmModelSupportsThinking, glmThinkingParams, isGlmModel } from "../reasoningEffort";
import {
	anthropicMaxOutput,
	anthropicThinkingConfig,
	claudeContextLength,
	fastModeBetaRequired,
	forbidsSamplingParams,
	isClaudeModel,
	rejectsForcedToolChoice,
} from "./anthropicModels";

import { inferModelCapabilities, knownContextLength } from "../modelCapabilities";

import { CommonApi } from "../commonApi";
import { accumulateUsage, type ApiUsage } from "../commonApi";
import { logger } from "../logger";
import { buildFetchNetworkInit, proxyFetch } from "../network";

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$ (ids minted by other providers may not). */
function sanitizeToolId(id: string): string {
	const cleaned = (id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
	return cleaned || `toolu_${Math.random().toString(36).slice(2, 10)}`;
}

function blockType(b: AnthropicContentBlock): string {
	return (b as { type?: string }).type ?? "";
}

/**
 * Merge consecutive same-role messages into one (concatenating content
 * blocks) to satisfy Anthropic's strict role-alternation requirement. In a
 * merged user turn tool_result blocks are moved first (Anthropic requires
 * them to lead the turn that answers a tool_use).
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
			// Thinking is only valid at the START of an assistant turn.
			const curFiltered =
				m.role === "assistant"
					? cur.filter((b) => blockType(b) !== "thinking" && blockType(b) !== "redacted_thinking")
					: cur;
			const merged = [...prev, ...curFiltered];
			last.content =
				m.role === "user"
					? [
							...merged.filter((b) => blockType(b) === "tool_result"),
							...merged.filter((b) => blockType(b) !== "tool_result"),
						]
					: merged;
			continue;
		}
		out.push(m);
	}
	return out;
}

/**
 * Enforce the tool_use ↔ tool_result pairing Anthropic validates (hermes
 * strips/repairs orphans): every assistant tool_use must be answered in the
 * NEXT user turn (a cancelled call gets a synthetic result), and a
 * tool_result without a preceding tool_use is downgraded to plain text.
 */
function repairToolPairing(messages: AnthropicMessage[]): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		const prev = out[out.length - 1];
		if (m.role === "user" && Array.isArray(m.content)) {
			const openIds = new Set<string>(
				prev && prev.role === "assistant" && Array.isArray(prev.content)
					? prev.content.filter((b) => blockType(b) === "tool_use").map((b) => (b as AnthropicToolUseBlock).id)
					: []
			);
			m.content = m.content.map((b): AnthropicContentBlock => {
				if (blockType(b) === "tool_result" && !openIds.has((b as AnthropicToolResultBlock).tool_use_id)) {
					const tr = b as AnthropicToolResultBlock;
					const text = typeof tr.content === "string" ? tr.content : tr.content.map((c) => ("text" in c ? c.text : "")).join("");
					return { type: "text", text: `Tool result (${tr.tool_use_id}):\n${text || "(no output)"}` };
				}
				return b;
			});
			// tool_result blocks must LEAD the turn — keep that after a
			// downgrade turned an orphan into text.
			m.content = [
				...m.content.filter((b) => blockType(b) === "tool_result"),
				...m.content.filter((b) => blockType(b) !== "tool_result"),
			];
		}
		out.push(m);
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const useIds = m.content.filter((b) => blockType(b) === "tool_use").map((b) => (b as AnthropicToolUseBlock).id);
			if (useIds.length === 0) {
				continue;
			}
			const next = messages[i + 1];
			const answered = new Set<string>(
				next && next.role === "user" && Array.isArray(next.content)
					? next.content.filter((b) => blockType(b) === "tool_result").map((b) => (b as AnthropicToolResultBlock).tool_use_id)
					: []
			);
			const missing: AnthropicToolResultBlock[] = useIds
				.filter((id) => !answered.has(id))
				.map((id) => ({ type: "tool_result", tool_use_id: id, content: "(tool call was cancelled — no output)", is_error: true }));
			if (missing.length === 0) {
				continue;
			}
			if (next && next.role === "user") {
				const rest: AnthropicContentBlock[] = Array.isArray(next.content)
					? next.content
					: [{ type: "text", text: String(next.content) }];
				next.content = [...missing, ...rest];
			} else {
				out.push({ role: "user", content: missing });
			}
		}
	}
	return out;
}

/**
 * Anthropic requires an object schema for every tool (hermes
 * `_normalize_tool_input_schema`): `{}` / missing → empty object schema;
 * top-level anyOf/oneOf/allOf are rejected; objects need `properties`.
 */
function normalizeAnthropicInputSchema(schema: object | undefined): Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
		return { type: "object", properties: {} };
	}
	const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
	if ("anyOf" in out || "oneOf" in out || "allOf" in out) {
		delete out.anyOf;
		delete out.oneOf;
		delete out.allOf;
	}
	if (out.type === undefined) {
		out.type = "object";
	}
	if (out.type === "object" && (!out.properties || typeof out.properties !== "object")) {
		out.properties = {};
	}
	return out;
}

/**
 * Block types that may carry a cache_control marker. Thinking blocks never
 * can (and a marker breaks signature validation); empty text blocks 400.
 */
function canCache(b: AnthropicContentBlock): boolean {
	const t = blockType(b);
	if (t === "text") {
		return typeof (b as AnthropicTextBlock).text === "string" && (b as AnthropicTextBlock).text.trim().length > 0;
	}
	return t === "image" || t === "tool_use" || t === "tool_result";
}

/**
 * One-shot request (no tools, no prior assistant turn, ≤1 user turn — e.g. a
 * commit-message call): a breakpoint would only buy a cache write (1.25x/2x)
 * that nothing ever reads (hermes `is_one_shot_request`).
 */
function isOneShotRequest(rb: AnthropicRequestBody): boolean {
	if (Array.isArray(rb.tools) && rb.tools.length > 0) {
		return false;
	}
	let users = 0;
	for (const m of rb.messages) {
		if (m.role === "assistant") {
			return false;
		}
		users++;
	}
	return users <= 1;
}

/** Models that get prompt caching by default (hermes `anthropic_prompt_cache_policy`). */
function cachesByDefault(model: string): boolean {
	const m = model.toLowerCase();
	if (isClaudeModel(model)) {
		return true;
	}
	// MiniMax M2.x honours explicit breakpoints; M3 caches server-side
	// automatically and gains nothing from markers.
	return /minimax-m2/.test(m);
}

/**
 * Effective prompt-cache TTL for a model, or undefined when caching is off.
 * Per-model `prompt_cache` wins (an explicit TTL also opts in non-default
 * families); otherwise the global `customcopilot.promptCacheTtl` applies to
 * the default families only.
 */
export function resolvePromptCacheTtl(model: string, um: CustomModelItem | undefined): "5m" | "1h" | undefined {
	const own = um?.prompt_cache;
	if (own === "off") {
		return undefined;
	}
	if (own === "5m" || own === "1h") {
		return own;
	}
	if (!cachesByDefault(model)) {
		return undefined;
	}
	const global = vscode.workspace.getConfiguration().get<string>("customcopilot.promptCacheTtl", "5m");
	return global === "1h" ? "1h" : global === "off" ? undefined : "5m";
}

export class AnthropicApi extends CommonApi<AnthropicMessage, AnthropicRequestBody> {
	/** Conversion settings of the current request (endpoint kind etc.). */
	private _conversionConfig: MessageConversionConfig = { includeReasoningInRequest: false };

	/** Streaming state for the content block currently open. */
	private _pendingThinking: { thinking: string; signature: string } | undefined;
	private _stopReason: string | undefined;
	private _sawMessageStop = false;
	/** Raw usage fields merged across message_start / message_delta. */
	private _rawUsage: NonNullable<AnthropicStreamChunk["usage"]> = {};

	constructor(modelId: string) {
		super(modelId);
	}

	/** Extra HTTP headers (anthropic-beta) the provider merges into the request. */
	public requestHeaders: Record<string, string> = {};

	/**
	 * Convert VS Code chat messages to Anthropic message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig model configuration that may affect message conversion.
	 * @returns Anthropic-compatible messages array.
	 */
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: MessageConversionConfig
	): AnthropicMessage[] {
		// Fresh conversion state per request (adapters are reused across turns).
		this.resetRequestState();
		this._conversionConfig = modelConfig;
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
			// Signed / redacted thinking captured from THIS model's earlier
			// responses (metadata on the closing ThinkingPart, the same
			// contract Copilot's BYOK Anthropic provider uses).
			const signedThinking: AnthropicContentBlock[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCalls.push({
						type: "tool_use",
						id: sanitizeToolId(part.callId || `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
						name: part.name,
						input: (part.input as Record<string, unknown>) ?? {},
					});
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const text = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					const images = collectToolResultImages(part as { content?: ReadonlyArray<unknown> });
					const content: AnthropicToolResultBlock["content"] =
						images.length > 0
							? [
									// Whitespace-only text blocks 400 ("must contain non-whitespace text").
									...(text.trim() ? [{ type: "text" as const, text }] : []),
									...images.map((img) => ({
										type: "image" as const,
										source: {
											type: "base64" as const,
											media_type: img.mimeType,
											data: Buffer.from(img.data).toString("base64"),
										},
									})),
								]
							: text || "(no output)";
					toolResults.push({
						type: "tool_result",
						tool_use_id: sanitizeToolId(callId),
						// Map the tool-error flag so the model can see failures.
						is_error: (part as { isError?: boolean }).isError === true || undefined,
						content,
					});
				} else if (part instanceof vscode.LanguageModelThinkingPart) {
					const meta = part.metadata as
						| { signature?: unknown; _completeThinking?: unknown; redactedData?: unknown; modelId?: unknown }
						| undefined;
					const sameModel = !meta?.modelId || meta.modelId === this._modelId;
					if (meta && typeof meta.redactedData === "string" && sameModel) {
						signedThinking.push({ type: "redacted_thinking", data: meta.redactedData });
					} else if (
						meta &&
						typeof meta.signature === "string" &&
						meta.signature &&
						typeof meta._completeThinking === "string" &&
						sameModel
					) {
						signedThinking.push({ type: "thinking", thinking: meta._completeThinking, signature: meta.signature });
					}
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

			if (role === "assistant") {
				if (signedThinking.length > 0) {
					// Signed blocks from this same model are replayed verbatim —
					// required to continue a tool-use loop with thinking on, and
					// the signature makes them valid on the endpoint that minted them.
					contentBlocks.push(...signedThinking);
				} else if (modelConfig.includeReasoningInRequest && joinedThinking && !modelConfig.nativeAnthropic) {
					// Kimi/DeepSeek-style Anthropic endpoints accept UNSIGNED
					// thinking (hermes: reasoning_content → leading thinking
					// block). The native API would 400 on a missing signature.
					contentBlocks.push({ type: "thinking", thinking: joinedThinking });
				} else if (modelConfig.includeReasoningInRequest && !modelConfig.nativeAnthropic && toolCalls.length > 0) {
					// Kimi/DeepSeek/MiMo require the reasoning on tool-call turns
					// even when none was captured (hermes pads with "").
					contentBlocks.push({ type: "thinking", thinking: "" });
				}
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
			if (role === "assistant") {
				contentBlocks.push(...toolCalls);
			}

			// Tool results live in user messages and must LEAD the turn.
			if (role === "user" && toolResults.length > 0) {
				contentBlocks.unshift(...toolResults);
			} else if (toolResults.length > 0) {
				// If tool results appear in non-user messages, log warning
				logger.warn("anthropic.tool-results.non-user", {
					messageRole: role,
					toolResultCount: toolResults.length,
				});
			}

			// An assistant turn consisting only of thinking is invalid.
			const hasNonThinking = contentBlocks.some(
				(b) => blockType(b) !== "thinking" && blockType(b) !== "redacted_thinking"
			);
			if (contentBlocks.length > 0 && hasNonThinking) {
				out.push({
					role,
					content: contentBlocks,
				});
			}
		}

		if (systemParts.length > 0) {
			this._systemContent = systemParts.join("\n\n");
		}

		// Merge consecutive same-role turns (Anthropic requires alternation),
		// then repair tool_use/tool_result pairing.
		let result = repairToolPairing(mergeConsecutiveAnthropicRoles(out));
		result = mergeConsecutiveAnthropicRoles(result);
		// The conversation must start with a user turn.
		if (result.length > 0 && result[0].role === "assistant") {
			result.unshift({ role: "user", content: [{ type: "text", text: "(empty)" }] });
		}
		return result;
	}

	prepareRequestBody(
		rb: AnthropicRequestBody,
		um: CustomModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): AnthropicRequestBody {
		const model = um?.id ?? rb.model ?? "";
		this.requestHeaders = {};

		// Set max_tokens (required for Anthropic). Claude defaults to the
		// model's output ceiling (thinking tokens count against it — a fixed
		// 16384 starved thinking models); other compatible endpoints keep
		// 16384 (Z.AI 500s if the field is missing).
		if (typeof um?.max_tokens === "number" && um.max_tokens > 0) {
			rb.max_tokens = Math.floor(um.max_tokens);
		} else {
			// Known families (Claude, MiniMax, Qwen3) use their ceiling; unknown
			// compatible models keep 16384.
			rb.max_tokens = anthropicMaxOutput(model) ?? 16384;
		}
		if (typeof um?.context_length === "number" && um.context_length > 1) {
			rb.max_tokens = Math.min(rb.max_tokens, um.context_length - 1);
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
		if (um?.top_k !== undefined && um.top_k !== null) {
			rb.top_k = um.top_k;
		}

		// Thinking (hermes `_thinking_kwargs`):
		// - adaptive Claude (4.6+ and unknown) → {type:"adaptive"} + output_config.effort;
		// - legacy Claude and non-Claude compat models (GLM, MiniMax…) →
		//   budget_tokens (explicit thinking_budget, else by effort), with
		//   temperature 1 and max_tokens ≥ budget + 4096;
		// - off → `disabled` / `between_tools` where the family accepts it,
		//   otherwise the field is omitted (omission = off on legacy models).
		const effort = typeof um?.reasoning_effort === "string" ? um.reasoning_effort.trim().toLowerCase() : "";
		const thinkingPolicy = anthropicThinkingConfig(model, resolveThinkingEnabled(um), effort);
		const userSetThinkingExtra = !!um?.extra && "thinking" in um.extra;
		let thinkingOn = false;
		// GLM on Z.AI's Anthropic wire (ZCode `zcode-builtin.json` reasoning
		// maps): `thinking:{type:enabled|disabled}` WITHOUT a budget; 5.2/5.3
		// take `output_config.effort` (5.2 high/max, 5.3 low..max and never
		// disabled → enabled+low). Server default is thinking ON, so "off"
		// must be sent explicitly. No forced temperature (ZCode sends none).
		const glmThinking = isGlmModel(model) && glmModelSupportsThinking(model) && !userSetThinkingExtra;
		if (glmThinking) {
			let enabled = resolveThinkingEnabled(um);
			if (enabled === undefined && effort === "none") {
				enabled = false;
			}
			const p = glmThinkingParams(model, enabled, effort);
			if (p.reasoning_effort) {
				rb.thinking = p.thinking ?? { type: "enabled" };
				rb.output_config = { effort: p.reasoning_effort };
			} else if (p.thinking) {
				rb.thinking = p.thinking;
			} else if (enabled === undefined && effort !== "") {
				// Effort on a pre-5.2 GLM = "think" (no effort field there).
				rb.thinking = { type: "enabled" };
			}
			thinkingOn = (rb.thinking as { type?: string } | undefined)?.type === "enabled";
		} else if (!userSetThinkingExtra) {
			if (thinkingPolicy.kind === "off") {
				if (thinkingPolicy.thinking) {
					rb.thinking = thinkingPolicy.thinking;
				}
			} else if (thinkingPolicy.kind === "adaptive") {
				rb.thinking = thinkingPolicy.thinking;
				if (thinkingPolicy.effort) {
					rb.output_config = { effort: thinkingPolicy.effort };
				}
				thinkingOn = true;
			} else if (thinkingPolicy.kind === "budget") {
				const budget = Math.max(1024, um?.thinking_budget ?? anthropicThinkingBudget(effort));
				rb.thinking = { type: "enabled", budget_tokens: budget };
				rb.max_tokens = Math.max(rb.max_tokens ?? 0, budget + 4096);
				thinkingOn = true;
			}
		}
		if (thinkingOn && !glmThinking) {
			// Thinking is incompatible with modified sampling: temperature must
			// be 1 (budget) / unset (adaptive), top_k is not allowed and top_p
			// must be ≥ 0.95.
			if (thinkingPolicy.kind === "budget") {
				rb.temperature = 1;
			} else {
				delete rb.temperature;
			}
			delete rb.top_k;
			if (typeof rb.top_p === "number" && rb.top_p < 0.95) {
				delete rb.top_p;
			}
		}
		// Opus 4.7+ (and unknown Claude) reject ANY sampling parameter.
		if (forbidsSamplingParams(model)) {
			delete rb.temperature;
			delete rb.top_p;
			delete rb.top_k;
		}

		// Add tools configuration
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			// Convert OpenAI tool definitions to Anthropic format
			// Duplicate tool names 400 — keep the first definition of each.
			const seenToolNames = new Set<string>();
			rb.tools = toolConfig.tools
				.filter((tool) => {
					if (seenToolNames.has(tool.function.name)) {
						return false;
					}
					seenToolNames.add(tool.function.name);
					return true;
				})
				.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: normalizeAnthropicInputSchema(tool.function.parameters),
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
		// Forced tool use is incompatible with extended thinking (400) — and
		// always-thinking families reject it even without a thinking field.
		// Z.AI/BigModel's Anthropic endpoint rejects a forced named tool for
		// GLM with 1210 regardless of thinking (ZCode websearch design notes).
		if (
			(thinkingOn || rejectsForcedToolChoice(model) || isGlmModel(model)) &&
			rb.tool_choice &&
			rb.tool_choice.type === "tool"
		) {
			rb.tool_choice = { type: "auto" };
		}

		// Beta features (native Anthropic only — compat gateways may 400 on
		// unknown betas): interleaved thinking between tool calls and
		// fine-grained tool streaming (hermes `_COMMON_BETAS`).
		const betas: string[] = [];
		if (this._conversionConfig.nativeAnthropic) {
			betas.push("interleaved-thinking-2025-05-14", "fine-grained-tool-streaming-2025-05-14");
		}

		// Fast mode (opt-in per model): same model, faster inference at
		// premium pricing. Opus 5 / 4.8 need the research-preview beta. Note:
		// fast and standard requests do not share prompt-cache prefixes.
		if (um?.fast_mode === true) {
			rb.speed = "fast";
			if (fastModeBetaRequired(model)) {
				betas.push("fast-mode-2026-02-01");
			}
		}
		if (betas.length > 0) {
			this.requestHeaders["anthropic-beta"] = betas.join(",");
		}

		// Prompt caching (explicit cache_control breakpoints). Agent loops
		// resend the same long prefix every turn, so this cuts cost and
		// latency substantially. A user-supplied top-level `cache_control`
		// in `extra` (automatic caching) takes over completely — mixing it
		// with our markers can exceed the 4-slot limit or clash on TTL (400).
		const userAutoCache = !!um?.extra && typeof um.extra === "object" && "cache_control" in um.extra;
		const cacheTtl = resolvePromptCacheTtl(model, um);
		if (cacheTtl && !userAutoCache && !isOneShotRequest(rb)) {
			// Tool-definition marker: native Anthropic always; compat gateways
			// only on an explicit per-model opt-in (some reject it on tools).
			const cacheTools = this._conversionConfig.nativeAnthropic === true || um?.prompt_cache !== undefined;
			this.applyCacheControl(rb, cacheTtl, cacheTools);
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
	 * Place up to 4 cache breakpoints (Anthropic limit), all with the same
	 * TTL (mixed TTLs must be ordered 1h→5m, so one TTL keeps it valid):
	 *  1. the last tool definition — tools are the head of the cached prefix
	 *     (tools → system → messages) and almost never change;
	 *  2. the last system block;
	 *  3+. the last cacheable block of the most recent messages. The newest
	 *     one moves the prefix forward each turn; the earlier one starts a
	 *     second 20-block lookback window so a turn with many parallel tool
	 *     calls still finds the previous write.
	 * Markers on string content convert it to a text-block array.
	 */
	private applyCacheControl(rb: AnthropicRequestBody, ttl: "5m" | "1h", cacheTools: boolean): void {
		const marker = (): AnthropicCacheControl => (ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
		let remaining = 4;

		if (cacheTools && Array.isArray(rb.tools) && rb.tools.length > 0) {
			rb.tools[rb.tools.length - 1].cache_control = marker();
			remaining--;
		}

		if (typeof rb.system === "string") {
			if (rb.system.trim()) {
				rb.system = [{ type: "text", text: rb.system, cache_control: marker() }];
				remaining--;
			}
		} else if (Array.isArray(rb.system)) {
			for (let j = rb.system.length - 1; j >= 0; j--) {
				if (rb.system[j].text?.trim()) {
					rb.system[j].cache_control = marker();
					remaining--;
					break;
				}
			}
		}

		for (let i = rb.messages.length - 1; i >= 0 && remaining > 0; i--) {
			const msg = rb.messages[i];
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					msg.content = [{ type: "text", text: msg.content, cache_control: marker() }];
					remaining--;
				}
				continue;
			}
			if (!Array.isArray(msg.content)) {
				continue;
			}
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const block = msg.content[j];
				if (canCache(block)) {
					(block as { cache_control?: AnthropicCacheControl }).cache_control = marker();
					remaining--;
					break;
				}
			}
		}
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
		this._pendingThinking = undefined;
		this._stopReason = undefined;
		this._sawMessageStop = false;
		this._rawUsage = {};
		logger.debug("anthropic.stream.start", { modelId });

		try {
			for await (const line of this.readStreamLines(responseBody, token)) {
				const data = CommonApi.sseData(line);
				if (!data) {
					continue;
				}
				logger.debug("anthropic.stream.chunk", { modelId, data });
				if (data === "[DONE]") {
					continue;
				}

				let chunk: AnthropicStreamChunk;
				try {
					chunk = JSON.parse(data);
				} catch (e) {
					console.error("[Anthropic Provider] Failed to parse SSE chunk:", e, "data:", data);
					logger.error("anthropic.stream.chunk.error", {
						modelId,
						error: e instanceof Error ? e.message : String(e),
						data,
					});
					continue;
				}
				// Processing errors (e.g. an in-stream `error` event) propagate.
				await this.processAnthropicChunk(chunk, progress);
			}
			await this.flushToolCallBuffers(progress, false);
			this.reportStopNotice(progress, this._stopReason);
			if (!this._sawMessageStop && !token.isCancellationRequested) {
				// Truncated stream (hermes raises EmptyStreamError). An empty one
				// is turned into a retryable error by the provider's empty guard;
				// a partial answer must not look complete.
				logger.warn("anthropic.stream.no-message-stop", { modelId, stopReason: this._stopReason ?? "" });
				if (this._hasEmittedAssistantText && !this._stopReason) {
					this.reportEndThinking(progress);
					progress.report(new vscode.LanguageModelTextPart("\n\n⚠️ The stream ended unexpectedly — the answer may be incomplete."));
				}
			}
			logger.debug("anthropic.stream.done", { modelId });
		} catch (e) {
			console.error("[Anthropic Provider] Streaming response error:", e);
			logger.error("anthropic.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
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
			this.recordUsage((chunk.message as { usage?: AnthropicStreamChunk["usage"] }).usage);
			return;
		}

		if (chunk.type === "message_delta") {
			// message_delta carries the final output token count (and, on
			// several compatible endpoints, the input count too).
			this.recordUsage(chunk.usage);
			if (chunk.delta?.stop_reason) {
				this._stopReason = chunk.delta.stop_reason;
			}
			return;
		}

		if (chunk.type === "content_block_start" && chunk.content_block) {
			const block = chunk.content_block;
			if (block.type === "thinking") {
				this._pendingThinking = { thinking: block.thinking ?? "", signature: block.signature ?? "" };
				if (block.thinking) {
					this.bufferThinkingContent(block.thinking, progress);
				}
			} else if (block.type === "redacted_thinking") {
				if (block.data) {
					this.reportThinkingMetadata(progress, { redactedData: block.data, modelId: this._modelId });
				}
			} else if (block.type === "tool_use") {
				this.reportEndThinking(progress);
				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}
				const idx = typeof chunk.index === "number" ? chunk.index : 0;
				this._toolCallBuffers.set(idx, {
					id: block.id,
					name: block.name,
					args: "",
				});
			} else if (block.type === "text" && block.text) {
				this.reportEndThinking(progress);
				progress.report(new vscode.LanguageModelTextPart(block.text));
				this._hasEmittedAssistantText = true;
			}
		} else if (chunk.type === "content_block_delta" && chunk.delta) {
			if (chunk.delta.type === "text_delta" && chunk.delta.text) {
				// Text closes any open thinking sequence first.
				this.reportEndThinking(progress);
				progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
				this._hasEmittedAssistantText = true;
			} else if (chunk.delta.type === "thinking_delta" && chunk.delta.thinking) {
				if (this._pendingThinking) {
					this._pendingThinking.thinking += chunk.delta.thinking;
				}
				this.bufferThinkingContent(chunk.delta.thinking, progress);
			} else if (chunk.delta.type === "input_json_delta" && typeof chunk.delta.partial_json === "string") {
				// Handle tool call argument streaming
				const idx = typeof chunk.index === "number" ? chunk.index : 0;
				const buf = this._toolCallBuffers.get(idx);
				if (buf) {
					buf.args += chunk.delta.partial_json;
				}
			} else if (chunk.delta.type === "signature_delta" && chunk.delta.signature) {
				if (this._pendingThinking) {
					this._pendingThinking.signature += chunk.delta.signature;
				}
			}
		} else if (chunk.type === "content_block_stop") {
			if (this._pendingThinking) {
				// Persist the complete signed thinking block for replay.
				const pending = this._pendingThinking;
				this._pendingThinking = undefined;
				if (pending.signature) {
					this.reportThinkingMetadata(progress, {
						signature: pending.signature,
						_completeThinking: pending.thinking,
						modelId: this._modelId,
					});
				} else {
					this.reportEndThinking(progress);
				}
				return;
			}
			// End of ONE content block: finalize only that block's index.
			// Flushing ALL buffers here would emit incomplete sibling tool_use
			// blocks and permanently break parallel tool calls.
			const idx = typeof chunk.index === "number" ? chunk.index : 0;
			await this.flushToolCallBufferAt(idx, progress, /*throwOnInvalid*/ false);
		} else if (chunk.type === "message_stop") {
			this._sawMessageStop = true;
			// End of message - ensure thinking is ended and flush all tool calls
			await this.flushToolCallBuffers(progress, false);
			this.reportEndThinking(progress);
		}
	}

	/** Merge an Anthropic usage object (message_start / message_delta) into `_lastUsage`. */
	private recordUsage(usage: AnthropicStreamChunk["usage"] | undefined): void {
		if (!usage) {
			return;
		}
		// Keep the last-seen value of EACH field: compat endpoints repeat
		// only some of them in message_delta (e.g. input_tokens without the
		// cache buckets), which must not reset the others.
		for (const [k, v] of Object.entries(usage)) {
			if (typeof v === "number") {
				(this._rawUsage as Record<string, number>)[k] = v;
			}
		}
		const merged = this._rawUsage;
		const patch: Partial<ApiUsage> = {};
		const input = merged.input_tokens ?? 0;
		const cacheRead = merged.cache_read_input_tokens ?? 0;
		const cacheWrite = merged.cache_creation_input_tokens ?? 0;
		// input_tokens is the UNCACHED remainder; the prompt total adds both
		// cache buckets. Ignore a zero placeholder so a later real count wins.
		if (input + cacheRead + cacheWrite > 0) {
			patch.prompt_tokens = input + cacheRead + cacheWrite;
			patch.prompt_tokens_details = { cached_tokens: cacheRead };
		}
		if (typeof merged.output_tokens === "number" && merged.output_tokens > 0) {
			patch.completion_tokens = merged.output_tokens;
		}
		if (Object.keys(patch).length > 0) {
			this._lastUsage = accumulateUsage(this._lastUsage, patch);
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
			...(signal ? { signal } : {}),
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
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.trim() === "" || !line.startsWith("data:")) {
						continue;
					}

					const data = line.slice(5).trim();
					if (data === "[DONE]") {continue;}

					try {
						const chunk: AnthropicStreamChunk = JSON.parse(data);

						// Anthropic streaming response
						if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta" && chunk.delta?.text) {
							yield { type: "text", text: chunk.delta.text };
						}

						// Handle message stop
						if (chunk.type === "message_stop") {
							break;
						}

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
			// Cancel (not only release) so an abandoned stream frees the socket.
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
}

/** One entry of Anthropic's `GET /v1/models` (only the fields we read). */
interface AnthropicModelInfo {
	id: string;
	display_name?: string;
	created_at?: string;
	/** Context window (input limit), e.g. 1_000_000. */
	max_input_tokens?: number;
	/** Synchronous output cap, e.g. 128_000 — NOT the context window. */
	max_tokens?: number;
	capabilities?: Record<string, unknown>;
}

function positiveInt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/** `capabilities.<name>.supported` (or a bare boolean); undefined when absent. */
function capabilitySupported(caps: Record<string, unknown> | undefined, name: string): boolean | undefined {
	const c = caps?.[name];
	if (typeof c === "boolean") {
		return c;
	}
	if (c && typeof c === "object" && typeof (c as { supported?: unknown }).supported === "boolean") {
		return (c as { supported: boolean }).supported;
	}
	return undefined;
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
			data?: AnthropicModelInfo[];
			has_more?: boolean;
			last_id?: string;
		};
		const entries = parsed.data ?? [];
		for (const entry of entries) {
			if (!entry || typeof entry.id !== "string") {
				continue;
			}
			// Anthropic's Models API reports `max_input_tokens` (the context
			// window, e.g. 1M) and `max_tokens` (the OUTPUT cap, e.g. 128K) plus
			// a `capabilities` object. Compat gateways (Z.AI, MiniMax…) omit
			// them, so fall back to the known per-family windows.
			const reportedInput = positiveInt(entry.max_input_tokens);
			const reportedOutput = positiveInt(entry.max_tokens);
			const contextLength = reportedInput ?? knownContextLength(entry.id) ?? claudeContextLength(entry.id);
			const imageInput = capabilitySupported(entry.capabilities, "image_input");
			models.push({
				id: entry.id,
				displayName: entry.display_name || entry.id,
				owned_by: apiMode === "zai" ? "zai" : "anthropic",
				apiMode: apiMode as import("../types").CustomApiMode,
				context_length: contextLength,
				max_tokens: reportedOutput ?? (apiMode === "zai" ? (anthropicMaxOutput(entry.id) ?? 16384) : undefined),
				tool_calling: true,
				vision: imageInput ?? (inferModelCapabilities({ id: entry.id }).vision || isClaudeModel(entry.id)),
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
