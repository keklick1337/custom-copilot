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
/** GLM-5.3 accepts low..max. */
export const GLM53_EFFORTS = ["low", "medium", "high", "max"] as const;
/** Alias spellings seen on relays (Fireworks ``glm-5p3``, ``glm-5-3``…). */
const GLM_5_3_TOKENS = ["glm-5.3", "glm-5-3", "glm-5p3"];

export type EffortLadderLevel = (typeof EFFORT_LADDER)[number];

function normalize(effort: string): string {
	return String(effort ?? "").trim().toLowerCase();
}

/**
 * Clamp a requested reasoning effort onto a wire's supported levels.
 * Mirrors hermes-agent `clamp_effort`:
 * - empty effort or unknown/empty supported set → pass through unchanged;
 * - effort already supported → verbatim;
 * - unrecognized (bespoke, non-ladder) effort → verbatim (custom providers
 *   may use their own names);
 * - otherwise the nearest WEAKER supported level (never "none" — clamping
 *   must not silently switch thinking off), else the weakest supported level.
 */
export function clampEffort(
	effort: string | undefined,
	supported: readonly string[] | undefined
): string | undefined {
	const requested = normalize(effort ?? "");
	if (!requested || !supported || supported.length === 0) {
		return effort;
	}
	const supportedNorm = supported.map(normalize).filter((lvl) => (EFFORT_LADDER as readonly string[]).includes(lvl));
	if (supportedNorm.length === 0 || supportedNorm.includes(requested)) {
		return effort;
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
/** Alias spellings seen on relays (Fireworks ``glm-5p3``, ``glm-5-3``…). */
/** GLM thinking-capable model families: glm-4.5 and later (4.5, 4.6, 5…). */
export function glmModelSupportsThinking(model: string | null | undefined): boolean {
	const match = GLM_VERSION_RE.exec((model ?? "").trim().toLowerCase());
	if (!match) {
		return false;
	}
	const major = parseInt(match[1], 10);
	const minor = match[2] ? parseInt(match[2], 10) : 0;
	return [major, minor] >= [4, 5] && (major > 4 || minor >= 5);
}

/**
 * Map a requested effort onto the GLM vocabulary: 5.2 accepts high/max,
 * 5.3 accepts low..max. Below-floor efforts clamp to the floor; unset or
 * "none" leaves the server default (returns undefined).
 */
export function glmReasoningEffort(
	effort: string | undefined,
	model: string | null | undefined
): string | undefined {
	const normalized = normalize(effort ?? "");
	if (!normalized || normalized === "none") {
		return undefined;
	}
	const m = (model ?? "").trim().toLowerCase();
	const is53 = GLM_5_3_TOKENS.some((token) => m.includes(token));
	const efforts = is53 ? GLM53_EFFORTS : GLM52_EFFORTS;
	const clamped = clampEffort(normalized, efforts);
	if (clamped && (efforts as readonly string[]).includes(normalize(clamped))) {
		return normalize(clamped);
	}
	// Floor: weakest level the family accepts.
	return efforts[0];
}
