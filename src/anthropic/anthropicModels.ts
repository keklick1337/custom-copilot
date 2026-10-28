/**
 * Claude model-family policy for the Anthropic Messages wire, ported from
 * hermes-agent `agent/anthropic_adapter.py`. Unknown Claude models default
 * to the MODERN contract (adaptive thinking, no sampling params); only the
 * explicit legacy lists stay on manual `budget_tokens` thinking. Non-Claude
 * Anthropic-compatible models (GLM, MiniMax, Qwen…) take the legacy path.
 */

/** Older Claude families that need manual thinking (budget_tokens only). */
const LEGACY_MANUAL_THINKING_CLAUDE = [
	"claude-3",
	"claude-opus-4-0",
	"claude-opus-4.0",
	"claude-opus-4-1",
	"claude-opus-4.1",
	"claude-sonnet-4-0",
	"claude-sonnet-4.0",
	"claude-opus-4-2025",
	"claude-sonnet-4-2025",
	"claude-opus-4-5",
	"claude-opus-4.5",
	"claude-sonnet-4-5",
	"claude-sonnet-4.5",
	"claude-haiku-4-5",
	"claude-haiku-4.5",
];
/** Adaptive families that reject "xhigh" and still accept sampling params. */
const NO_XHIGH_CLAUDE = ["claude-opus-4-6", "claude-opus-4.6", "claude-sonnet-4-6", "claude-sonnet-4.6"];
/** Families where thinking is mandatory (`disabled` → 400). */
const MANDATORY_THINKING_CLAUDE = ["claude-fable", "claude-opus-5-5", "claude-opus-5.5"];
/** Families whose documented "off" is `between_tools`. */
const BETWEEN_TOOLS_OFF_CLAUDE = ["claude-sonnet-5-5", "claude-sonnet-5.5"];

/** Families that reject a forced tool_choice (`tool` / `any`) — they always think. */
const FORCED_TOOL_CHOICE_REJECTED_CLAUDE = [
	"claude-fable",
	"claude-mythos",
	"claude-opus-5-5",
	"claude-opus-5.5",
	"claude-sonnet-5-5",
	"claude-sonnet-5.5",
];

/** True when the model 400s on `tool_choice: {type: "tool" | "any"}`. */
export function rejectsForcedToolChoice(model: string): boolean {
	return matches(model, [...FORCED_TOOL_CHOICE_REJECTED_CLAUDE, ...MANDATORY_THINKING_CLAUDE]);
}

/** Hermes effort → Anthropic adaptive `output_config.effort`. */
const ADAPTIVE_EFFORT_MAP: Readonly<Record<string, string>> = {
	ultra: "max",
	max: "max",
	xhigh: "xhigh",
	high: "high",
	medium: "medium",
	low: "low",
	minimal: "low",
};

/** Max output tokens per model (longest substring match wins). */
const OUTPUT_LIMITS: Readonly<Record<string, number>> = {
	"claude-fable": 128_000,
	"claude-sonnet-5": 128_000,
	"claude-opus-4-8": 128_000,
	"claude-opus-4-7": 128_000,
	"claude-opus-4-6": 128_000,
	"claude-sonnet-4-6": 64_000,
	"claude-opus-4-5": 64_000,
	"claude-sonnet-4-5": 64_000,
	"claude-haiku-4-5": 64_000,
	"claude-opus-4": 32_000,
	"claude-sonnet-4": 64_000,
	// 128K output needs the output-128k beta, which is not sent.
	"claude-3-7-sonnet": 64_000,
	"claude-3-5-sonnet": 8_192,
	"claude-3-5-haiku": 8_192,
	"claude-3-opus": 4_096,
	"claude-3-sonnet": 4_096,
	"claude-3-haiku": 4_096,
	minimax: 131_072,
	qwen3: 65_536,
	// GLM (Z.AI catalog, ZCode `zcode-builtin.json`); ids normalized "."→"-".
	"glm-5-3": 128_000,
	"glm-5-2": 128_000,
	"glm-5v-turbo": 131_072,
	"glm-5": 64_000,
	"glm-4-7": 131_072,
	"glm-4-6v": 32_768,
	"glm-4-6": 131_072,
	"glm-4-5v": 16_384,
	"glm-4-5": 98_304,
	"glm-4-1v": 32_768,
	"glm-4-flash": 16_384,
};
const DEFAULT_CLAUDE_OUTPUT_LIMIT = 128_000;

function matches(model: string, substrings: readonly string[]): boolean {
	const m = model.toLowerCase();
	return substrings.some((s) => m.includes(s));
}

export function isClaudeModel(model: string | null | undefined): boolean {
	return (model ?? "").toLowerCase().includes("claude");
}

/** Kimi / Moonshot family slugs (hermes `_model_name_is_kimi_family`). */
const KIMI_FAMILY_PREFIXES = ["kimi-", "kimi_", "moonshot-", "moonshot_", "k1.", "k1-", "k2.", "k2-", "k25", "k2.5", "k3.", "k3-"];

function isKimiModel(model: string): boolean {
	const m = model.trim().toLowerCase();
	const bare = m.slice(m.lastIndexOf("/") + 1);
	return bare === "k3" || KIMI_FAMILY_PREFIXES.some((p) => bare.startsWith(p));
}

/** Claude 3.x families without extended thinking (3.7 Sonnet has it). */
const NO_THINKING_CLAUDE = /claude-3-(5-)?haiku|claude-3-haiku|claude-3-5-sonnet|claude-3-opus|claude-3-sonnet|claude-instant/i;

/** Claude 4.6+ (and unknown Claude) use adaptive thinking; so do Kimi's Anthropic endpoints. */
export function supportsAdaptiveThinking(model: string): boolean {
	return isKimiModel(model) || (isClaudeModel(model) && !matches(model, LEGACY_MANUAL_THINKING_CLAUDE));
}

function supportsXhighEffort(model: string): boolean {
	return supportsAdaptiveThinking(model) && !matches(model, NO_XHIGH_CLAUDE);
}

/** Effort levels the model picker should offer for a Claude model ("none" = thinking off). */
export function claudeEffortLevels(model: string): string[] {
	if (!isClaudeModel(model) || NO_THINKING_CLAUDE.test(model)) {
		return [];
	}
	const canDisable = !matches(model, MANDATORY_THINKING_CLAUDE);
	const levels = supportsAdaptiveThinking(model)
		? ["low", "medium", "high", ...(supportsXhighEffort(model) ? ["xhigh"] : []), "max"]
		: ["low", "medium", "high", "max"];
	return canDisable ? ["none", ...levels] : levels;
}

/** Opus 4.7+ (and unknown Claude) 400 on any temperature/top_p/top_k. */
export function forbidsSamplingParams(model: string): boolean {
	return isClaudeModel(model) && !matches(model, [...NO_XHIGH_CLAUDE, ...LEGACY_MANUAL_THINKING_CLAUDE]);
}

/**
 * Claude context windows (hermes `DEFAULT_CONTEXT_LENGTHS` + Anthropic models
 * overview): the 4.6+ generation (Opus 4.6–4.8, Sonnet 4.6) and every 5.x /
 * Fable / Mythos model have 1M; older Claude 200K. Used when `/v1/models`
 * does not report `max_input_tokens` (compat gateways, OAuth tokens).
 */
const MILLION_CONTEXT_CLAUDE = /claude-(fable|mythos)|claude-(opus|sonnet|haiku)-[5-9]|claude-(opus|sonnet)-4-([6-9])/;

export function claudeContextLength(model: string): number | undefined {
	if (!isClaudeModel(model)) {
		return undefined;
	}
	const m = model.toLowerCase().replace(/\./g, "-");
	return MILLION_CONTEXT_CLAUDE.test(m) ? 1_000_000 : 200_000;
}

/**
 * Fast mode (`speed: "fast"`) models: Opus 5.5 is GA; Opus 5 / Opus 4.8 are
 * a research preview behind the `fast-mode-2026-02-01` beta header.
 */
export function fastModeBetaRequired(model: string): boolean {
	const m = model.toLowerCase().replace(/\./g, "-");
	return /claude-opus-4-[68]|claude-opus-5(?!-[1-9])/.test(m);
}

/** Model output ceiling for Claude/known families; undefined for unknown non-Claude models. */
export function anthropicMaxOutput(model: string): number | undefined {
	const m = model.toLowerCase().replace(/\./g, "-");
	let best: string | undefined;
	for (const key of Object.keys(OUTPUT_LIMITS)) {
		if (m.includes(key) && (!best || key.length > best.length)) {
			best = key;
		}
	}
	if (best) {
		return OUTPUT_LIMITS[best];
	}
	return isClaudeModel(model) ? DEFAULT_CLAUDE_OUTPUT_LIMIT : undefined;
}

/**
 * The thinking fields for a request (hermes `_thinking_kwargs`).
 * @param enabled explicit on/off preference; undefined = none.
 * @param effort requested effort (may be empty).
 */
export function anthropicThinkingConfig(
	model: string,
	enabled: boolean | undefined,
	effort: string
):
	| { kind: "off"; thinking?: Record<string, unknown> }
	| { kind: "adaptive"; thinking: Record<string, unknown>; effort?: string }
	| { kind: "budget" }
	| { kind: "none" } {
	if (enabled === false) {
		if (matches(model, BETWEEN_TOOLS_OFF_CLAUDE)) {
			return { kind: "off", thinking: { type: "between_tools" } };
		}
		const acceptsDisable =
			isClaudeModel(model) &&
			supportsAdaptiveThinking(model) &&
			!matches(model, [...MANDATORY_THINKING_CLAUDE, ...BETWEEN_TOOLS_OFF_CLAUDE]);
		return acceptsDisable ? { kind: "off", thinking: { type: "disabled" } } : { kind: "off" };
	}
	const wants = enabled === true || (effort !== "" && effort !== "none");
	if (!wants || NO_THINKING_CLAUDE.test(model)) {
		// No thinking support on pre-3.7 Claude: sending it would 400.
		return { kind: "none" };
	}
	if (supportsAdaptiveThinking(model)) {
		// hermes defaults the adaptive effort to "medium" (the server default
		// would be "high" — more cost than the user asked for).
		let adaptiveEffort = ADAPTIVE_EFFORT_MAP[effort] ?? "medium";
		if (adaptiveEffort === "xhigh" && !supportsXhighEffort(model)) {
			adaptiveEffort = "max";
		}
		return { kind: "adaptive", thinking: { type: "adaptive", display: "summarized" }, effort: adaptiveEffort };
	}
	return { kind: "budget" };
}
