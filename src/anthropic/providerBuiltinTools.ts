import type { AnthropicStreamChunk } from "./anthropicTypes";

/**
 * Provider-executed ("built-in") tools on Anthropic-compatible endpoints —
 * GLM on Z.AI / BigModel appends its own tools (`analyze_image`, `webReader`,
 * …) to every request and runs them SERVER-SIDE inside one response (ported
 * from ZCode `provider-builtin-tool-compat`). The stream then contains:
 *
 *   old: text("**🌐 Z.ai Built-in Tool: analyze_image** …") → server_tool_use(analyze_image)
 *        → text("**Output:** …") → bare tool_result → next round's text
 *   new: text("**🌐 …") → mcp_tool_use → mcp_tool_result → text("**Output:**\n**analyze_image_result_summary:** …")
 *
 * Without this filter the markdown renderings land in the answer AND in the
 * history, and the model starts imitating "tool calls" in plain text. Here:
 * - the rendered copies are dropped — only once the stream structure confirms
 *   them (a bold answer is never swallowed by mistake);
 * - each call + result is shown as a short line in the thinking block;
 * - completed rounds are returned for the response metadata, so the next
 *   request can replay them as a proper tool_use / tool_result pair (ZCode's
 *   "plan A", verified against the real server);
 * - a bare tool_result without a matching call is dropped.
 * The calls are never surfaced as LanguageModelToolCallParts: Copilot would
 * try to execute them.
 */

export interface ProviderToolRound {
	id: string;
	name: string;
	input: Record<string, unknown>;
	result: string;
	isError: boolean;
}

/** server_tool_use names a standard Anthropic client understands — not ours to rewrite. */
const KNOWN_SERVER_TOOLS = new Set([
	"web_fetch",
	"web_search",
	"code_execution",
	"text_editor_code_execution",
	"bash_code_execution",
	"tool_search_tool_regex",
	"tool_search_tool_bm25",
	"advisor",
]);

const CALL_PREFIX = "**🌐";
const SUMMARY_PREFIX = "**Output:**";

interface RawBlock {
	type?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
	text?: string;
}

interface HeldText {
	index: number;
	text: string;
	stopped: boolean;
	/** "probe" = undecided; call/result/summary = candidate rendering. */
	kind: "probe" | "call" | "result" | "summary";
}

function isBuiltinCall(b: RawBlock | undefined): boolean {
	return (
		!!b &&
		typeof b.id === "string" &&
		((b.type === "server_tool_use" && typeof b.name === "string" && !KNOWN_SERVER_TOOLS.has(b.name)) || b.type === "mcp_tool_use")
	);
}

function isResultBlock(b: RawBlock | undefined): boolean {
	return !!b && (b.type === "tool_result" || b.type === "mcp_tool_result") && typeof b.tool_use_id === "string";
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === "string" ? c : c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : JSON.stringify(c)))
			.join("\n");
	}
	return content === undefined ? "" : JSON.stringify(content);
}

/** Readable form of a result like `["Order Console\nError 1302 …"]`. */
function readable(text: string): string {
	const t = text.trim();
	if (t.startsWith("[") || t.startsWith("\"")) {
		try {
			const v = JSON.parse(t) as unknown;
			if (Array.isArray(v)) {
				return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
			}
			if (typeof v === "string") {
				return v;
			}
		} catch {
			// keep as is
		}
	}
	return t;
}

function brief(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export class ProviderBuiltinToolFilter {
	readonly rounds: ProviderToolRound[] = [];
	private calls = new Map<string, { name: string; input: Record<string, unknown>; json: string }>();
	private callIndex = new Map<number, string>();
	private resultIndex = new Map<number, { id: string; text: string; isError: boolean }>();
	private dropIndex = new Set<number>();
	private openCalls = new Set<string>();
	private lastResultName: string | undefined;
	private held: HeldText | undefined;

	constructor(
		private readonly emitText: (text: string) => void,
		private readonly emitThinking: (text: string) => void
	) {}

	reset(): void {
		this.rounds.length = 0;
		this.resetMessage();
	}

	private resetMessage(): void {
		this.calls.clear();
		this.callIndex.clear();
		this.resultIndex.clear();
		this.dropIndex.clear();
		this.openCalls.clear();
		this.lastResultName = undefined;
		this.held = undefined;
	}

	/**
	 * Feed one stream chunk. Returns true when it was consumed here (the
	 * caller must not process it); false for normal handling.
	 */
	handle(chunk: AnthropicStreamChunk): boolean {
		const idx = typeof chunk.index === "number" ? chunk.index : 0;
		switch (chunk.type) {
			case "message_start":
				this.flushHeld();
				this.resetMessage();
				return false;
			case "message_delta":
			case "message_stop":
				this.flushHeld();
				return false;
			case "content_block_start": {
				const block = chunk.content_block as RawBlock | undefined;
				this.resolveHeld(block);
				if (!block) {
					return false;
				}
				if (block.type === "text") {
					this.held = { index: idx, text: block.text ?? "", stopped: false, kind: "probe" };
					this.decide();
					return true;
				}
				if (isBuiltinCall(block)) {
					const id = block.id as string;
					const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
					this.calls.set(id, { name: String(block.name ?? "tool"), input, json: "" });
					this.callIndex.set(idx, id);
					this.openCalls.add(id);
					return true;
				}
				if (isResultBlock(block)) {
					const id = block.tool_use_id as string;
					if (this.calls.has(id)) {
						this.resultIndex.set(idx, { id, text: contentText(block.content), isError: block.is_error === true });
					} else {
						// A bare result without a call: not a valid assistant block.
						this.dropIndex.add(idx);
					}
					return true;
				}
				return false;
			}
			case "content_block_delta": {
				const delta = chunk.delta as { type?: string; text?: string; partial_json?: string } | undefined;
				if (this.dropIndex.has(idx)) {
					return true;
				}
				const callId = this.callIndex.get(idx);
				if (callId) {
					if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
						const call = this.calls.get(callId);
						if (call) {
							call.json += delta.partial_json;
						}
					}
					return true;
				}
				const result = this.resultIndex.get(idx);
				if (result) {
					if (typeof delta?.text === "string") {
						result.text += delta.text;
					}
					return true;
				}
				if (this.held && this.held.index === idx) {
					if (delta?.type === "text_delta" && typeof delta.text === "string") {
						this.held.text += delta.text;
						this.decide();
					}
					return true;
				}
				return false;
			}
			case "content_block_stop": {
				if (this.dropIndex.delete(idx)) {
					return true;
				}
				const callId = this.callIndex.get(idx);
				if (callId) {
					this.callIndex.delete(idx);
					const call = this.calls.get(callId);
					if (call && call.json.trim()) {
						try {
							call.input = { ...call.input, ...(JSON.parse(call.json) as Record<string, unknown>) };
						} catch {
							// keep the start-block input
						}
					}
					if (call) {
						const prompt = typeof call.input.prompt === "string" ? `: ${brief(call.input.prompt, 160)}` : "";
						this.emitThinking(`\n\n🔧 ${call.name} (server-side)${prompt}\n`);
					}
					return true;
				}
				const result = this.resultIndex.get(idx);
				if (result) {
					this.resultIndex.delete(idx);
					const call = this.calls.get(result.id);
					const text = readable(result.text);
					this.rounds.push({ id: result.id, name: call?.name ?? "tool", input: call?.input ?? {}, result: text, isError: result.isError });
					this.openCalls.delete(result.id);
					this.lastResultName = call?.name;
					this.emitThinking(`${result.isError ? "✖" : "→"} ${brief(text, 600) || "(empty result)"}\n\n`);
					return true;
				}
				if (this.held && this.held.index === idx) {
					this.held.stopped = true;
					if (this.held.kind === "summary") {
						const t = this.held.text.trimStart();
						const isCopy =
							!!this.lastResultName && t.slice(SUMMARY_PREFIX.length).trimStart().startsWith(`**${this.lastResultName}_result_summary:**`);
						if (isCopy) {
							this.held = undefined;
						} else {
							this.flushHeld();
						}
					} else if (this.held.kind === "probe") {
						this.flushHeld();
					}
					// call / result copies wait for the next block to confirm them.
					return true;
				}
				return false;
			}
			default:
				return false;
		}
	}

	/** End of stream: release anything still held. */
	finish(): void {
		this.flushHeld();
	}

	/** Classify a held text block as soon as its start is known. */
	private decide(): void {
		const h = this.held;
		if (!h || h.kind !== "probe") {
			return;
		}
		const t = h.text.trimStart();
		if (t.startsWith(CALL_PREFIX)) {
			h.kind = "call";
			return;
		}
		if (t.startsWith(SUMMARY_PREFIX) && this.lastResultName) {
			h.kind = "summary";
			return;
		}
		if (t.startsWith("**") && this.openCalls.size > 0) {
			h.kind = "result";
			return;
		}
		// Still a possible prefix of a rendering: wait for more text.
		if ((CALL_PREFIX.startsWith(t) || SUMMARY_PREFIX.startsWith(t)) && t.length < SUMMARY_PREFIX.length) {
			return;
		}
		// Ordinary answer text: stream it from here on.
		this.held = undefined;
		if (h.text) {
			this.emitText(h.text);
		}
	}

	/** A new block starts: confirm (drop) or release a held rendering. */
	private resolveHeld(next: RawBlock | undefined): void {
		const h = this.held;
		if (!h) {
			return;
		}
		if (h.stopped && h.kind === "call" && isBuiltinCall(next)) {
			this.held = undefined;
			return;
		}
		if (h.stopped && h.kind === "result" && isResultBlock(next) && this.openCalls.has(String(next?.tool_use_id))) {
			this.held = undefined;
			return;
		}
		this.flushHeld();
	}

	private flushHeld(): void {
		const h = this.held;
		this.held = undefined;
		if (h && h.text) {
			this.emitText(h.text);
		}
	}
}
