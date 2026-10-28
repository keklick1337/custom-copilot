/**
 * Reasoning-effort vocabulary normalization, ported from hermes-agent
 * (`agent/reasoning_effort.py`). A requested effort is passed through
 * verbatim when the target wire supports it; otherwise it is clamped to the
 * NEAREST WEAKER supported level (a clamp must never escalate cost), or the
 * provider's floor when nothing weaker exists.
 */

/** Canonical effort ladder, weakest → strongest. */
export const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** The widest effort set an arbitrary OpenAI-compatible endpoint accepts
 * (vLLM, SGLang, GLM/ARK all top out at "max"; "ultra" verbatim 400s). */
export const OPENAI_COMPAT_WIRE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** GLM-5.2 effort vocabulary (5.3 is a superset; see `GLM53_EFFORTS`). */
export const GLM52_EFFORTS = ["high", "max"] as const;
/** GLM-5.3 accepts low..max (verified live on the coding endpoint, hermes #91789). */
export const GLM53_EFFORTS = ["low", "medium", "high", "max"] as const;
/** Both GLM vocabularies stop at "max": "xhigh" maps UP to it (hermes GLM5x_OVERRIDES). */
const GLM_EFFORT_OVERRIDES: Readonly<Record<string, string>> = { xhigh: "max" };
/** Alias spellings seen on relays (Fireworks ``glm-5p3``, ``glm-5-3``…). */
const GLM_5_3_TOKENS = ["glm-5.3", "glm-5-3", "glm-5p3"];
/** GLM-5.2 tokens; 5.3 is a superset of the 5.2 wire (takes reasoning_effort too). */
const GLM_5_2_TOKENS = ["glm-5.2", "glm-5-2", "glm-5p2", ...GLM_5_3_TOKENS];

export type EffortLadderLevel = (typeof EFFORT_LADDER)[number];

function normalize(effort: string): string {
	return String(effort ?? "").trim().toLowerCase();
}

/**
 * Clamp a requested reasoning effort onto a wire's supported levels.
 * Mirrors hermes-agent `clamp_effort`:
 * - explicit overrides (when the target is supported) win first;
 * - empty effort or unknown/empty supported set → pass through unchanged;
 * - effort already supported → verbatim;
 * - unrecognized (bespoke, non-ladder) effort → verbatim (custom providers
 *   may use their own names);
 * - otherwise the nearest WEAKER supported level (never "none" — clamping
 *   must not silently switch thinking off), else the weakest supported level.
 */
export function clampEffort(
	effort: string | undefined,
	supported: readonly string[] | undefined,
	overrides?: Readonly<Record<string, string>>
): string | undefined {
	const requested = normalize(effort ?? "");
	if (!requested || !supported || supported.length === 0) {
		return effort;
	}
	const supportedNorm = supported.map(normalize).filter((lvl) => (EFFORT_LADDER as readonly string[]).includes(lvl));
	if (supportedNorm.length === 0 || supportedNorm.includes(requested)) {
		return effort;
	}
	// Explicit per-wire overrides win (e.g. GLM "xhigh" → "max").
	const override = overrides?.[requested];
	if (override && supportedNorm.includes(override)) {
		return override;
	}
	if (!(EFFORT_LADDER as readonly string[]).includes(requested)) {
		return effort;
	}
	const requestedIdx = (EFFORT_LADDER as readonly string[]).indexOf(requested);
	const candidates = supportedNorm.filter((lvl) => lvl !== "none");
	if (candidates.length === 0) {
		return effort;
	}
	const below = candidates.filter((lvl) => (EFFORT_LADDER as readonly string[]).indexOf(lvl) < requestedIdx);
	if (below.length > 0) {
		return below.reduce((a, b) =>
			(EFFORT_LADDER as readonly string[]).indexOf(b) > (EFFORT_LADDER as readonly string[]).indexOf(a) ? b : a
		);
	}
	return candidates.reduce((a, b) =>
		(EFFORT_LADDER as readonly string[]).indexOf(b) < (EFFORT_LADDER as readonly string[]).indexOf(a) ? b : a
	);
}

// ---------------------------------------------------------------------------
// GLM / Z.AI helpers (ported from hermes-agent plugins/model-providers/zai)
// ---------------------------------------------------------------------------

const GLM_VERSION_RE = /^glm-(\d+)(?:\.(\d+))?/;

function hasToken(model: string | null | undefined, tokens: readonly string[]): boolean {
	const m = (model ?? "").trim().toLowerCase();
	return tokens.some((token) => m.includes(token));
}

/** Strip a relay/vendor prefix (``z-ai/glm-5.1``, ``zai-org/GLM-4.6``) before matching. */
function glmBareId(model: string | null | undefined): string {
	const m = (model ?? "").trim().toLowerCase();
	const slash = m.lastIndexOf("/");
	return slash >= 0 ? m.slice(slash + 1) : m;
}

/** True for GLM model ids (any version, any relay prefix). */
export function isGlmModel(model: string | null | undefined): boolean {
	return glmBareId(model).startsWith("glm");
}

/** True for GLM-5.3 family ids (5.3, 5.3-flash, relay spellings). */
export function isGlm53Model(model: string | null | undefined): boolean {
	return hasToken(model, GLM_5_3_TOKENS);
}

/** True for ids on the GLM-5.2+ wire, which accepts a top-level `reasoning_effort`. */
export function isGlm52PlusModel(model: string | null | undefined): boolean {
	return hasToken(model, GLM_5_2_TOKENS);
}

/** GLM thinking-capable model families: glm-4.5 and later (4.5, 4.6, 5…), plus any 5.2/5.3 spelling. */
export function glmModelSupportsThinking(model: string | null | undefined): boolean {
	if (isGlm52PlusModel(model)) {
		return true;
	}
	const match = GLM_VERSION_RE.exec(glmBareId(model));
	if (!match) {
		return false;
	}
	const major = parseInt(match[1], 10);
	const minor = match[2] ? parseInt(match[2], 10) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

/**
 * Map a requested effort onto the GLM vocabulary: 5.2 accepts high/max,
 * 5.3 accepts low..max ("xhigh" → "max"). Below-floor efforts clamp to the
 * floor. Unset or "none" leaves the server default (returns undefined), and
 * models before 5.2 never take a `reasoning_effort` at all.
 */
export function glmReasoningEffort(
	effort: string | undefined,
	model: string | null | undefined
): string | undefined {
	const normalized = normalize(effort ?? "");
	if (!normalized || normalized === "none" || !isGlm52PlusModel(model)) {
		return undefined;
	}
	const efforts = isGlm53Model(model) ? GLM53_EFFORTS : GLM52_EFFORTS;
	const clamped = normalize(clampEffort(normalized, efforts, GLM_EFFORT_OVERRIDES) ?? "");
	if ((efforts as readonly string[]).includes(clamped)) {
		return clamped;
	}
	// Floor: weakest level the family accepts.
	return efforts[0];
}

/**
 * The GLM thinking fields for the OpenAI-compatible Z.AI wire (hermes
 * `ZaiProfile.build_api_kwargs_extras`). Only emits when the user expressed
 * a preference — the server default is thinking ON.
 * - `enabled` undefined → no `thinking` field (server default);
 * - GLM-5.3 rejects disabled thinking → `enabled` + effort "low" instead;
 * - 5.2/5.3 additionally take a clamped top-level `reasoning_effort`.
 */
export function glmThinkingParams(
	model: string | null | undefined,
	enabled: boolean | undefined,
	effort: string | undefined
): { thinking?: { type: "enabled" | "disabled" }; reasoning_effort?: string } {
	if (!glmModelSupportsThinking(model)) {
		return {};
	}
	const out: { thinking?: { type: "enabled" | "disabled" }; reasoning_effort?: string } = {};
	if (enabled === false && isGlm53Model(model)) {
		return { thinking: { type: "enabled" }, reasoning_effort: "low" };
	}
	if (enabled !== undefined) {
		out.thinking = { type: enabled ? "enabled" : "disabled" };
	}
	if (enabled !== false) {
		const e = glmReasoningEffort(effort, model);
		if (e) {
			out.reasoning_effort = e;
		}
	}
	return out;
}

/**
 * Manual-thinking budgets for non-Claude models on an Anthropic-compatible
 * wire (GLM over /api/anthropic, MiniMax, Kimi…) — hermes `THINKING_BUDGET`.
 */
export const ANTHROPIC_THINKING_BUDGET: Readonly<Record<string, number>> = {
	minimal: 4000,
	low: 4000,
	medium: 8000,
	high: 16000,
	xhigh: 32000,
	max: 32000,
	ultra: 32000,
};

/** Budget for an effort (default 8000, hermes `THINKING_BUDGET.get(effort, 8000)`). */
export function anthropicThinkingBudget(effort: string | undefined): number {
	return ANTHROPIC_THINKING_BUDGET[normalize(effort ?? "")] ?? 8000;
}

// ---------------------------------------------------------------------------
// Per-provider OpenAI-compatible thinking profiles (hermes model-providers)
// ---------------------------------------------------------------------------

/** DeepSeek V4+: low..max ("xhigh" → "max"). */
export const DEEPSEEK_V4_EFFORTS = ["low", "medium", "high", "max"] as const;
/** Kimi K3: low/high/max ("medium" → "high", "xhigh" → "max"); K2: low/medium/high. */
export const KIMI_K3_EFFORTS = ["low", "high", "max"] as const;
export const KIMI_K2_EFFORTS = ["low", "medium", "high"] as const;
const KIMI_K3_OVERRIDES: Readonly<Record<string, string>> = { medium: "high", xhigh: "max" };
/** Ollama Cloud: "minimal" 400s; "none" is the only off switch. */
export const OLLAMA_CLOUD_EFFORTS = ["none", "low", "medium", "high", "max"] as const;
const XHIGH_TO_MAX: Readonly<Record<string, string>> = { xhigh: "max" };

function isKnownCompatHost(host: string): boolean {
	return (
		host === "api.deepseek.com" ||
		host.endsWith("moonshot.ai") ||
		host.endsWith("moonshot.cn") ||
		host === "api.kimi.com" ||
		host === "ollama.com" ||
		host.endsWith(".ollama.com")
	);
}

export interface CompatThinkingParams {
	thinking?: { type: "enabled" | "disabled" };
	reasoning_effort?: string;
	/** Ollama native toggle accepted on its OpenAI-compatible /v1 wire. */
	think?: boolean;
}

/** "none" / "false" / "disabled" all mean thinking OFF (hermes parse_reasoning_effort). */
function isOffEffort(effort: string): boolean {
	return effort === "none" || effort === "false" || effort === "disabled" || effort === "off";
}

/**
 * hermes `thinking_toggle_extras`: Moonshot 400s when both the `thinking`
 * toggle and `reasoning_effort` are sent, so the effort (when supported)
 * replaces the toggle; DeepSeek requires the toggle on every request
 * (`alwaysToggle`). "none" is not a level on these wires.
 */
function thinkingToggleExtras(
	enabled: boolean | undefined,
	effort: string,
	efforts: readonly string[],
	overrides: Readonly<Record<string, string>> | undefined,
	alwaysToggle: boolean
): CompatThinkingParams {
	if (enabled === false || isOffEffort(effort)) {
		return { thinking: { type: "disabled" } };
	}
	const clamped = effort ? normalize(clampEffort(effort, efforts, overrides) ?? "") : "";
	if (clamped && efforts.includes(clamped)) {
		return alwaysToggle ? { thinking: { type: "enabled" }, reasoning_effort: clamped } : { reasoning_effort: clamped };
	}
	return enabled === true || alwaysToggle ? { thinking: { type: "enabled" } } : {};
}

/**
 * Provider-specific thinking fields for the OpenAI-compatible wire, or
 * undefined when the generic handling (clamp onto OPENAI_COMPAT_WIRE_EFFORTS)
 * applies. Z.AI is handled by `glmThinkingParams`.
 */
export function compatThinkingParams(
	host: string,
	baseUrl: string,
	model: string,
	enabled: boolean | undefined,
	effortRaw: string | undefined
): CompatThinkingParams | undefined {
	const m = (model ?? "").trim().toLowerCase();
	const bare = m.slice(m.lastIndexOf("/") + 1);
	const effort = normalize(effortRaw ?? "");
	if (host === "api.deepseek.com") {
		// DeepSeek V4+ ALWAYS gets the toggle (default on): an omitted toggle
		// still thinks and then demands reasoning_content echoes.
		const thinkingModel = (bare.startsWith("deepseek-v") && !bare.startsWith("deepseek-v3")) || bare === "deepseek-flash";
		return thinkingModel ? thinkingToggleExtras(enabled, effort, DEEPSEEK_V4_EFFORTS, XHIGH_TO_MAX, true) : {};
	}
	if (enabled === undefined && !effort) {
		return isKnownCompatHost(host) ? {} : undefined;
	}
	if (host.endsWith("moonshot.ai") || host.endsWith("moonshot.cn") || host === "api.kimi.com") {
		const k3 = /(?:^|[^a-z0-9])k3(?:[^a-z0-9]|$)/.test(bare);
		return thinkingToggleExtras(
			enabled,
			effort,
			k3 ? KIMI_K3_EFFORTS : KIMI_K2_EFFORTS,
			k3 ? KIMI_K3_OVERRIDES : undefined,
			false
		);
	}
	if (host === "ollama.com" || host.endsWith(".ollama.com")) {
		if (enabled === false || isOffEffort(effort)) {
			return { reasoning_effort: "none" };
		}
		const clamped = effort ? normalize(clampEffort(effort, OLLAMA_CLOUD_EFFORTS, XHIGH_TO_MAX) ?? "") : "";
		// Unknown (non-ladder) efforts are dropped, not sent verbatim (400).
		return clamped && clamped !== "none" && (OLLAMA_CLOUD_EFFORTS as readonly string[]).includes(clamped)
			? { reasoning_effort: clamped }
			: {};
	}
	// Local Ollama /v1 (port 11434 or an "ollama" host label): disabling also
	// needs the native `think: false` (hermes custom profile).
	const localOllama = /:11434(\/|$)/.test(baseUrl) || /(^|\.)ollama(\.|$)/.test(host);
	if (localOllama && (enabled === false || isOffEffort(effort))) {
		return { reasoning_effort: "none", think: false };
	}
	return undefined;
}
