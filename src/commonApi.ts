import * as vscode from "vscode";
import {
	ProvideLanguageModelChatResponseOptions,
	LanguageModelChatRequestMessage,
	LanguageModelToolCallPart,
	LanguageModelResponsePart2,
	LanguageModelThinkingPart,
	Progress,
	CancellationToken,
} from "vscode";
import { CustomModelItem } from "./types";
import { tryParseJSONObject } from "./utils";
import { VersionManager, resolveUserAgent } from "./versionManager";

/**
 * Token usage in the shape Copilot's BYOK providers report it (see the
 * `usage` LanguageModelDataPart contract in Copilot's endpointTypes:
 * `CustomDataPartMimeTypes.Usage`). Only prompt/completion/total are
 * required for the chat context circle to render.
 */
export interface ApiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: {
		cached_tokens: number;
		[key: string]: unknown;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** Merge/replace the usage accumulator with numbers from a stream chunk. */
export function accumulateUsage(target: ApiUsage | undefined, patch: Partial<ApiUsage>): ApiUsage {
	const next: ApiUsage = target
		? { ...target }
		: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
	if (typeof patch.prompt_tokens === "number") {
		next.prompt_tokens = patch.prompt_tokens;
	}
	if (typeof patch.completion_tokens === "number") {
		next.completion_tokens = patch.completion_tokens;
	}
	if (typeof patch.total_tokens === "number") {
		next.total_tokens = patch.total_tokens;
	} else {
		// Always recompute when not explicitly provided: an earlier partial
		// patch may have derived a premature total that must be updated once
		// the second half (prompt/completion) arrives.
		next.total_tokens = next.prompt_tokens + next.completion_tokens;
	}
	if (patch.prompt_tokens_details && typeof patch.prompt_tokens_details === "object") {
		next.prompt_tokens_details = { ...(next.prompt_tokens_details ?? { cached_tokens: 0 }), ...patch.prompt_tokens_details };
	}
	if (patch.completion_tokens_details && typeof patch.completion_tokens_details === "object") {
		next.completion_tokens_details = { ...(next.completion_tokens_details ?? {}), ...patch.completion_tokens_details };
	}
	return next;
}

export abstract class CommonApi<TMessage, TRequestBody> {
	/** Buffer for assembling streamed tool calls by index. */
	protected _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	protected _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	protected _hasEmittedAssistantText = false;

	/** Track if we emitted any text. */
	protected _hasEmittedText = false;

	/** Track if we emitted any thinking text. */
	protected _hasEmittedThinking = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	protected _emittedBeginToolCallsHint = false;

	// XML think block parsing state. `_xmlThinkCarryOver` holds a possible
	// partial "<think>"/"</think>" tag split across chunk boundaries so the
	// one-shot detection flag can't permanently miss a split tag.
	protected _xmlThinkActive = false;
	protected _xmlThinkDetectionAttempted = false;
	protected _xmlThinkCarryOver = "";

	// Thinking content state management
	protected _currentThinkingId: string | null = null;

	/** Buffer for accumulating thinking content before emitting. */
	protected _thinkingBuffer = "";

	/** Timer for delayed flushing of thinking buffer. */
	protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

	/** System prompts to include in requests. */
	protected _systemContent: string | undefined;

	/**
	 * Token usage reported by the provider for the current response, in the
	 * Copilot BYOK `APIUsage` shape (prompt_tokens / completion_tokens /
	 * total_tokens). Adapters populate it from their stream's usage event;
	 * the provider emits it as a `LanguageModelDataPart` with mimeType
	 * "usage" after streaming completes — that is the internal contract the
	 * Copilot Chat context-usage circle listens for.
	 */
	protected _lastUsage: ApiUsage | undefined;

	/** Set the model ID for logging purposes. */
	protected _modelId = "";

	constructor(modelId: string) {
		this._modelId = modelId;
	}

	/**
	 * Reset ALL per-request streaming/conversion state. MUST be called at the
	 * start of `convertMessages` and `processStreamingResponse` — adapter
	 * instances must be safely reusable across turns and chat-level retries
	 * (stale `_completedToolCallIndices` would silently swallow tool calls at
	 * already-seen indices, stale `_systemContent` would leak the previous
	 * conversation's system prompt).
	 */
	protected resetRequestState(): void {
		this._toolCallBuffers.clear();
		this._completedToolCallIndices.clear();
		this._hasEmittedAssistantText = false;
		this._hasEmittedText = false;
		this._hasEmittedThinking = false;
		this._emittedBeginToolCallsHint = false;
		this._xmlThinkActive = false;
		this._xmlThinkDetectionAttempted = false;
		this._xmlThinkCarryOver = "";
		this._currentThinkingId = null;
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
		this._systemContent = undefined;
		this._lastUsage = undefined;
	}

	/**
	 * Convert VS Code chat messages to specific api message format.
	 * @param messages The VS Code chat messages to convert.
	 * @param modelConfig Config for special model.
	 * @returns Specific api messages array.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): TMessage[];

	/**
	 * Construct request body for Specific api
	 * @param rb Specific api Request body
	 * @param um Current Model Info
	 * @param options From VS Code
	 */
	abstract prepareRequestBody(
		rb: TRequestBody,
		um: CustomModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): TRequestBody;

	/**
	 * Process specific api streaming response (JSON lines format).
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 */
	abstract processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void>;

	/**
	 * Create a message stream for the specific API.
	 * @param model The model to use.
	 * @param systemPrompt The system prompt to use.
	 * @param messages The messages to send.
	 * @param baseUrl The base URL for the API.
	 * @param apiKey The API key to use.
	 * @returns An async iterable of text chunks.
	 */
	abstract createMessage(
		model: CustomModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }>;

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		if (!buf.name) {
			return;
		}
		const canParse = tryParseJSONObject(buf.args);
		if (!canParse.ok) {
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		let parameters = canParse.value;
		parameters = this.adjustReadFileParameters(buf.name, parameters);
		progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush a single buffered tool call by index, optionally throwing on invalid
	 * JSON args. Use this for per-index completion events (e.g. Anthropic
	 * `content_block_stop`, OpenAI Responses `*_done`) so incomplete sibling
	 * buffers are NOT prematurely emitted.
	 * @param index The tool call index to flush.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when the args are not valid JSON.
	 */
	protected async flushToolCallBufferAt(
		index: number,
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf) {
			return;
		}
		const argsText = buf.args.trim() || "{}";
		const parsed = tryParseJSONObject(argsText);
		if (!parsed.ok) {
			if (throwOnInvalid) {
				console.error("[customcopilot] Invalid JSON for tool call", {
					index,
					snippet: (buf.args || "").slice(0, 200),
				});
				throw new Error("Invalid JSON for tool call");
			}
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const name = buf.name ?? "unknown_tool";
		let parameters = parsed.value;
		parameters = this.adjustReadFileParameters(name, parameters);
		progress.report(new LanguageModelToolCallPart(id, name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			// [FIX] Normalize empty args to "{}" for parameterless tool calls
			const argsText = buf.args.trim() || "{}";
			const parsed = tryParseJSONObject(argsText);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					console.error("[customcopilot] Invalid JSON for tool call", {
						idx,
						snippet: (buf.args || "").slice(0, 200),
					});
					throw new Error("Invalid JSON for tool call");
				}
				// When not throwing (e.g. on [DONE]), drop silently to reduce noise
				continue;
			}
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			let parameters = parsed.value;
			parameters = this.adjustReadFileParameters(name, parameters);
			progress.report(new LanguageModelToolCallPart(id, name, parameters));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	/**
	 * Adjust read_file tool parameters to default to reading configurable number of lines.
	 * @param toolName The name of the tool being called.
	 * @param parameters The tool parameters.
	 * @returns Adjusted parameters.
	 */
	protected adjustReadFileParameters(toolName: string, parameters: Record<string, unknown>): Record<string, unknown> {
		if (toolName !== "read_file") {
			return parameters;
		}
		const config = vscode.workspace.getConfiguration();
		const defaultLines = config.get<number>("customcopilot.readFileLines", 0);
		if (defaultLines <= 0) {
			return parameters;
		}

		const startLine = typeof parameters.startLine === "number" ? parameters.startLine : 1;
		const endLine = typeof parameters.endLine === "number" ? parameters.endLine : startLine;
		if (endLine < startLine + defaultLines) {
			return { ...parameters, endLine: startLine + defaultLines };
		}
		return parameters;
	}

	/**
	 * Report to VS Code for ending thinking
	 * @param progress Progress reporter for parts
	 */
	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>) {
		if (!this._currentThinkingId) {
			return;
		}
		// Always clean up state after attempting to end the thinking sequence
		try {
			this.flushThinkingBuffer(progress);
			// End the current thinking sequence with empty content and same ID
			progress.report(new LanguageModelThinkingPart("", this._currentThinkingId));
		} catch (e) {
			console.error("[customcopilot] Failed to end thinking sequence:", e);
		}
		this._currentThinkingId = null;
		// Clear thinking buffer and timer since sequence ended
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
	}

	/**
	 * Generate a unique thinking ID based on request start time and random suffix
	 */
	protected generateThinkingId(): string {
		return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Buffer and schedule a flush for thinking content.
	 * @param text The thinking text to buffer
	 * @param progress Progress reporter for parts
	 */
	protected bufferThinkingContent(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		this._hasEmittedThinking = true;
		// Generate thinking ID if not provided by the model
		if (!this._currentThinkingId) {
			this._currentThinkingId = this.generateThinkingId();
		}

		// Append to thinking buffer
		this._thinkingBuffer += text;

		// Schedule flush with 100ms delay
		if (!this._thinkingFlushTimer) {
			this._thinkingFlushTimer = setTimeout(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	/**
	 * Flush the thinking buffer to the progress reporter.
	 * @param progress Progress reporter for parts.
	 */
	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		// Always clear existing timer first
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}

		// Flush current buffer if we have content
		if (this._thinkingBuffer && this._currentThinkingId) {
			const text = this._thinkingBuffer;
			this._thinkingBuffer = "";
			progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId));
		}
	}

	/**
	 * Prepare headers for API request.
	 * @param apiKey The API key to use.
	 * @param apiMode The apiMode (affects header format).
	 * @param customHeaders Optional custom headers from model config.
	 * @returns Headers object.
	 */
	public static prepareHeaders(
		apiKey: string,
		apiMode: string,
		customHeaders?: Record<string, string>,
		userAgent?: string
	): Record<string, string> {
		// "random-browser" resolves to a FRESH browser UA on every request;
		// any other value (including empty) falls back to the configured
		// default UA, itself passed through the same resolver.
		const explicit = (userAgent || "").trim();
		const resolvedUserAgent = explicit
			? resolveUserAgent(explicit) || VersionManager.getUserAgent()
			: resolveUserAgent(VersionManager.getUserAgent());
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": resolvedUserAgent,
		};

		// Provider-specific header formats
		if (apiMode === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "zai") {
			// Z.AI uses Anthropic-compatible API with Bearer auth (not x-api-key)
			headers["Authorization"] = `Bearer ${apiKey}`;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
		} else if (apiMode === "gemini") {
			headers["x-goog-api-key"] = apiKey;
			headers["Accept"] = "text/event-stream";
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		// Merge custom headers
		if (customHeaders) {
			return { ...headers, ...customHeaders };
		}

		return headers;
	}

	/**
	 * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
	 * Returns which parts were emitted for logging/flow control.
	 */
	protected processTextContent(input: string, progress: Progress<LanguageModelResponsePart2>): { emittedAny: boolean } {
		let emittedAny = false;

		// Emit any visible text
		const textToEmit = input;
		if (textToEmit && textToEmit.length > 0) {
			progress.report(new vscode.LanguageModelTextPart(textToEmit));
			emittedAny = true;
		}

		return { emittedAny };
	}

	/**
	 * Process streamed text content for XML think blocks and buffer thinking content.
	 * Returns whether any XML think tags were processed (preventing text fallback).
	 */
	protected processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		const THINK_START = "<think>";
		const THINK_END = "</think>";

		// Combine any carried-over partial tag from the previous chunk.
		let data = this._xmlThinkCarryOver + input;
		this._xmlThinkCarryOver = "";
		let emittedAny = false;

		// While not inside a think block and detection hasn't concluded, hold
		// back a trailing partial "<think>" prefix so a tag split across chunk
		// boundaries isn't missed (which would disable detection forever).
		if (!this._xmlThinkActive && !this._xmlThinkDetectionAttempted) {
			for (let keep = Math.min(THINK_START.length - 1, data.length); keep > 0; keep--) {
				if (THINK_START.startsWith(data.slice(-keep))) {
					this._xmlThinkCarryOver = data.slice(-keep);
					data = data.slice(0, -keep);
					break;
				}
			}
		}

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				// Look for think start tag
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					// No think start found: emit as visible text (if not a held-back
					// carry-over remnant) and mark detection as attempted.
					this._xmlThinkDetectionAttempted = true;
					if (data) {
						this.reportEndThinking(progress);
						progress.report(new vscode.LanguageModelTextPart(data));
						this._hasEmittedText = true;
						emittedAny = true;
					}
					data = "";
					break;
				}

				// Emit any visible text before the think block
				if (startIdx > 0) {
					this.reportEndThinking(progress);
					progress.report(new vscode.LanguageModelTextPart(data.slice(0, startIdx)));
					this._hasEmittedText = true;
					emittedAny = true;
				}

				// Found think start tag - mark that we processed XML tags
				emittedAny = true;
				this._xmlThinkActive = true;

				// Skip the start tag and continue processing
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			// We are inside a think block, look for end tag
			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
				// Hold back a possible partial "</think>" suffix inside thinking.
				let emit = data;
				for (let keep = Math.min(THINK_END.length - 1, data.length); keep > 0; keep--) {
					if (THINK_END.startsWith(data.slice(-keep))) {
						this._xmlThinkCarryOver = data.slice(-keep);
						emit = data.slice(0, -keep);
						break;
					}
				}
				if (emit) {
					this.bufferThinkingContent(emit, progress);
					emittedAny = true;
				}
				data = "";
				break;
			}

			// Found end tag, buffer final thinking content before the end tag
			const thinkContent = data.slice(0, endIdx);
			if (thinkContent) {
				this.bufferThinkingContent(thinkContent, progress);
			}

			// Mark end tag as processed and reset state — a SECOND <think>
			// block in the same response is now handled correctly.
			emittedAny = true;
			this._xmlThinkActive = false;
			data = data.slice(endIdx + THINK_END.length);
		}

		return { emittedAny };
	}
}
