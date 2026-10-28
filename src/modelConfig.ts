import type { LanguageModelConfigurationSchema } from "vscode";
import type { CustomApiMode, CustomModelItem } from "./types";
import { claudeEffortLevels, isClaudeModel } from "./anthropic/anthropicModels";
import { GLM52_EFFORTS, GLM53_EFFORTS, glmModelSupportsThinking, isGlm52PlusModel, isGlm53Model, isGlmModel } from "./reasoningEffort";

/**
 * Per-model options shown in the Copilot Chat model picker (same contract as
 * Copilot's own models): `reasoningEffort` in the "navigation" group and
 * `contextSize` in the "tokens" group. VS Code passes the user's choice back
 * as `options.modelConfiguration`, and agent mode budgets the prompt on
 * `contextSize` (compacting earlier).
 */

const EFFORT_LABELS: Record<string, string> = {
	none: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
	none: "No reasoning — fastest, cheapest",
	minimal: "Minimal reasoning for fastest responses",
	low: "Faster responses with less reasoning",
	medium: "Balanced reasoning and speed",
	high: "Greater reasoning depth but slower",
	xhigh: "Highest reasoning depth but slowest",
	max: "Absolute maximum capability",
};

const CONTEXT_FRACTIONS = [1, 0.75, 0.5, 0.25] as const;

/** Smallest context window worth offering fractions for. */
const MIN_CONTEXT_FOR_STEPS = 32_000;

const GENERIC_EFFORTS = ["none", "low", "medium", "high"];
const GEMINI_EFFORTS = ["none", "low", "medium", "high"];
const OPENAI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

/** True when the model is known (or configured) to think. */
function thinks(m: CustomModelItem): boolean {
	return (
		m.enable_thinking === true ||
		(typeof m.reasoning_effort === "string" && m.reasoning_effort !== "") ||
		m.reasoning?.enabled === true ||
		typeof m.thinking?.type === "string" ||
		typeof m.thinking_budget === "number"
	);
}

/** Effort levels to offer for a model, or [] when the picker should not show one. */
export function effortLevelsFor(m: CustomModelItem, apiMode: CustomApiMode): string[] {
	const id = (m.id ?? "").toLowerCase();
	if (isGlmModel(id)) {
		if (!glmModelSupportsThinking(id)) {
			return [];
		}
		if (isGlm53Model(id)) {
			// 5.3 cannot be switched off ("off" maps to enabled + low).
			return [...GLM53_EFFORTS];
		}
		if (isGlm52PlusModel(id)) {
			return ["none", ...GLM52_EFFORTS];
		}
		return ["none", "high"];
	}
	if (isClaudeModel(id) && (apiMode === "anthropic" || apiMode === "zai")) {
		return claudeEffortLevels(id);
	}
	if (apiMode === "gemini") {
		return /^gemini-(2\.5|[3-9])/.test(id.replace(/^models\//, "")) ? GEMINI_EFFORTS : [];
	}
	if (apiMode === "openai-responses" || /^(o[1-9]|gpt-5)/.test(id.slice(id.lastIndexOf("/") + 1))) {
		return OPENAI_REASONING_EFFORTS;
	}
	return thinks(m) ? GENERIC_EFFORTS : [];
}

/** The model's configured default effort, mapped onto the offered levels. */
function defaultEffort(m: CustomModelItem, levels: string[]): string {
	const configured = typeof m.reasoning_effort === "string" ? m.reasoning_effort.trim().toLowerCase() : "";
	if (levels.includes(configured)) {
		return configured;
	}
	if (m.enable_thinking === false || m.thinking?.type === "disabled") {
		if (levels.includes("none")) {
			return "none";
		}
	}
	const id = (m.id ?? "").toLowerCase();
	const unconfigured = !thinks(m);
	// Unconfigured = keep today's behavior: Claude doesn't think unless asked; GLM thinks at the server default (top level).
	if (unconfigured && isClaudeModel(id) && levels.includes("none")) {
		return "none";
	}
	if (unconfigured && isGlmModel(id)) {
		return levels[levels.length - 1];
	}
	for (const pick of ["medium", "high", "low"]) {
		if (levels.includes(pick)) {
			return pick;
		}
	}
	return levels[levels.length - 1];
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M`;
	}
	return `${Math.round(n / 1000)}K`;
}

/** Context-size choices: 100 / 75 / 50 / 25 % of the window (deduped, ≥ 8K). */
export function contextSizeOptions(contextWindow: number): number[] {
	if (contextWindow < MIN_CONTEXT_FOR_STEPS) {
		return [];
	}
	const values = CONTEXT_FRACTIONS.map((f) => Math.floor(contextWindow * f)).filter((v) => v >= 8_000);
	return [...new Set(values)];
}

/** Build the picker schema for a model; undefined when there is nothing to configure. */
export function buildConfigurationSchema(
	m: CustomModelItem,
	apiMode: CustomApiMode,
	contextWindow: number
): LanguageModelConfigurationSchema | undefined {
	const properties: Record<string, Record<string, unknown>> = {};

	const levels = effortLevelsFor(m, apiMode);
	if (levels.length > 1) {
		properties.reasoningEffort = {
			type: "string",
			title: "Effort Level",
			enum: levels,
			enumItemLabels: levels.map((l) => EFFORT_LABELS[l] ?? l),
			enumDescriptions: levels.map((l) => EFFORT_DESCRIPTIONS[l] ?? l),
			default: defaultEffort(m, levels),
			group: "navigation",
		};
	}

	const sizes = contextSizeOptions(contextWindow);
	if (sizes.length > 1) {
		properties.contextSize = {
			type: "number",
			title: "Context Size",
			enum: sizes,
			enumItemLabels: sizes.map(formatTokens),
			enumDescriptions: sizes.map((v) => `${Math.round((v / contextWindow) * 100)}% of the ${formatTokens(contextWindow)} window`),
			default: sizes[0],
			group: "tokens",
		};
	}

	return Object.keys(properties).length > 0 ? ({ properties } as LanguageModelConfigurationSchema) : undefined;
}

/**
 * Apply the picker choices to the effective model config for one request.
 * `reasoningEffort: "none"` switches thinking off; a reduced `contextSize`
 * caps `context_length` (Ollama `num_ctx`, Anthropic max_tokens clamp).
 */
export function applyModelConfiguration(
	um: CustomModelItem,
	modelConfiguration: Readonly<Record<string, unknown>> | undefined
): CustomModelItem {
	if (!modelConfiguration) {
		return um;
	}
	const out: CustomModelItem = { ...um };
	const effort = modelConfiguration.reasoningEffort;
	if (typeof effort === "string" && effort) {
		const e = effort.trim().toLowerCase();
		out.reasoning_effort = e;
		if (e === "none") {
			out.enable_thinking = false;
		} else {
			// An explicit level means "think": drop a stale configured off-switch.
			if (out.enable_thinking === false) {
				out.enable_thinking = true;
			}
			if (out.thinking?.type === "disabled") {
				out.thinking = { ...out.thinking, type: "enabled" };
			}
		}
		if (out.reasoning && typeof out.reasoning === "object") {
			out.reasoning = { ...out.reasoning, enabled: e !== "none", effort: e === "none" ? undefined : e };
		}
	}
	const size = modelConfiguration.contextSize;
	if (typeof size === "number" && Number.isFinite(size) && size > 0) {
		const current = out.context_length;
		if (current === undefined || size < current) {
			out.context_length = Math.floor(size);
		}
	}
	return out;
}
