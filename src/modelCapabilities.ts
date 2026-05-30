/**
 * Model capability inference for OpenAI-compatible (and similar) endpoints.
 *
 * Plain OpenAI `/v1/models` responses usually do NOT advertise per-model
 * capabilities (tool/function calling, vision/image input, context window).
 * VS Code's built-in "Bring Your Own Key" (BYOK) provider solves this with a
 * known-model capability table plus field inference, defaulting unknown models
 * to safe values (see `extensions/copilot/src/extension/byok` in vscode).
 *
 * This module replicates that strategy and improves on it:
 *   1. Parse rich capability fields when the endpoint provides them
 *      (OpenRouter / OpenAI-router style: `supported_parameters`,
 *      `architecture.input_modalities`, `features`, `input_modalities`, ...).
 *   2. Fall back to substring inference from the model id for well-known
 *      families (gpt-4o, o-series, claude-3/4, gemini, llama vision, qwen-vl …).
 *   3. Apply sensible defaults so modern chat models still get tool calling.
 */

export interface InferredCapabilities {
	vision: boolean;
	toolCalling: boolean;
	contextLength?: number;
	maxOutputTokens?: number;
	reasoning: boolean;
}

/** Lowercased substrings of model ids that are known to accept image input. */
const VISION_ID_PATTERNS: string[] = [
	"gpt-4o",
	"gpt-4.1",
	"gpt-4-turbo",
	"gpt-4-vision",
	"gpt-4v",
	"chatgpt-4o",
	"gpt-5",
	"o1",
	"o3",
	"o4",
	"claude-3",
	"claude-4",
	"claude-opus",
	"claude-sonnet",
	"claude-haiku",
	"gemini",
	"llava",
	"llama-3.2",
	"llama3.2",
	"llama-4",
	"llama4",
	"llama-vision",
	"pixtral",
	"qwen-vl",
	"qwen2-vl",
	"qwen2.5-vl",
	"qwen3-vl",
	"qwenvl",
	"internvl",
	"minicpm-v",
	"phi-3-vision",
	"phi-3.5-vision",
	"phi-4-multimodal",
	"grok-2-vision",
	"grok-4",
	"grok-vision",
	"mistral-small-3",
	"mistral-medium-3",
	"molmo",
	"step-1v",
	"yi-vision",
	"glm-4v",
	"glm-4.1v",
	"deepseek-vl",
	"cogvlm",
	"idefics",
	"fuyu",
	"kosmos",
	"aria",
	"nova-lite",
	"nova-pro",
];

/** Substrings indicating a non-chat model that supports neither tools nor vision. */
const NON_CHAT_ID_PATTERNS: string[] = [
	"embedding",
	"embed",
	"text-embedding",
	"whisper",
	"tts",
	"audio-speech",
	"dall-e",
	"dalle",
	"stable-diffusion",
	"sdxl",
	"flux",
	"moderation",
	"rerank",
	"reranker",
	"clip",
	"bge-",
	"e5-",
	"gte-",
	"jina-embed",
	"voyage",
	"upscale",
	"image-generation",
	"img2img",
	"text2image",
];

/** Substrings of model ids that are known reasoning / thinking models. */
const REASONING_ID_PATTERNS: string[] = [
	"o1",
	"o3",
	"o4",
	"gpt-5",
	"deepseek-r",
	"deepseek-reasoner",
	"qwq",
	"reasoning",
	"thinking",
	"magistral",
	"grok-3-mini",
	"grok-4",
	"phi-4-reasoning",
];

function idMatches(id: string, patterns: string[]): boolean {
	return patterns.some((p) => id.includes(p));
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
}

function toBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const v = value.toLowerCase();
		if (v === "true" || v === "yes" || v === "1") {
			return true;
		}
		if (v === "false" || v === "no" || v === "0") {
			return false;
		}
	}
	return undefined;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n) && n > 0) {
			return n;
		}
	}
	return undefined;
}

/**
 * Detect vision support from any rich capability fields the endpoint provides.
 * Returns undefined when no relevant field is present so the caller can fall
 * back to id-based inference.
 */
function detectVisionFromFields(m: Record<string, unknown>): boolean | undefined {
	// OpenRouter style: architecture.input_modalities: ["text", "image"]
	const architecture = m.architecture as Record<string, unknown> | undefined;
	const archModalities = asStringArray(architecture?.input_modalities);
	if (archModalities.length > 0) {
		return archModalities.includes("image") || archModalities.includes("video");
	}

	// OpenAI-router style: input_modalities / modalities at the top level.
	const modalities = asStringArray(m.input_modalities).concat(asStringArray(m.modalities));
	if (modalities.length > 0) {
		return modalities.includes("image") || modalities.includes("video");
	}

	// Explicit boolean flags some providers expose.
	for (const key of ["vision", "supports_vision", "multimodal", "image_input"]) {
		const b = toBool(m[key]);
		if (b !== undefined) {
			return b;
		}
	}

	// Some providers nest capabilities under `capabilities` / `supports`.
	const caps = (m.capabilities ?? m.supports) as Record<string, unknown> | undefined;
	if (caps) {
		for (const key of ["vision", "image_input", "multimodal"]) {
			const b = toBool(caps[key]);
			if (b !== undefined) {
				return b;
			}
		}
	}

	return undefined;
}

/**
 * Detect tool/function-calling support from any rich capability fields.
 * Returns undefined when no relevant field is present.
 */
function detectToolsFromFields(m: Record<string, unknown>): boolean | undefined {
	// OpenRouter style: supported_parameters: ["tools", "tool_choice", ...]
	const supportedParams = asStringArray(m.supported_parameters);
	if (supportedParams.length > 0) {
		return (
			supportedParams.includes("tools") ||
			supportedParams.includes("tool_choice") ||
			supportedParams.includes("functions") ||
			supportedParams.includes("function_call")
		);
	}

	// OpenAI-router style: features: ["function-calling", "tools", ...]
	const features = asStringArray(m.features);
	if (features.length > 0) {
		return (
			features.includes("function-calling") ||
			features.includes("function_calling") ||
			features.includes("tools") ||
			features.includes("tool-calling") ||
			features.includes("tool_calling") ||
			features.includes("structured-outputs") ||
			features.includes("structured_outputs")
		);
	}

	// Explicit boolean flags.
	for (const key of ["tool_calling", "supports_tools", "function_calling", "supports_function_calling", "tools"]) {
		const b = toBool(m[key]);
		if (b !== undefined) {
			return b;
		}
	}

	// Nested capabilities / supports objects.
	const caps = (m.capabilities ?? m.supports) as Record<string, unknown> | undefined;
	if (caps) {
		for (const key of ["tool_calls", "tool_calling", "tools", "function_calling"]) {
			const b = toBool(caps[key]);
			if (b !== undefined) {
				return b;
			}
		}
	}

	// HF-router style: providers[].supports_tools
	const providers = m.providers as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(providers) && providers.length > 0) {
		const anyKnown = providers.some((p) => typeof p.supports_tools === "boolean");
		if (anyKnown) {
			return providers.some((p) => p.supports_tools === true);
		}
	}

	return undefined;
}

function detectContextLength(m: Record<string, unknown>): number | undefined {
	const topProvider = m.top_provider as Record<string, unknown> | undefined;
	return (
		toNumber(m.context_length) ??
		toNumber(m.context_size) ??
		toNumber(m.context_window) ??
		toNumber(m.max_context_length) ??
		toNumber(m.max_context) ??
		toNumber(m.n_ctx) ??
		toNumber(topProvider?.context_length)
	);
}

function detectMaxOutputTokens(m: Record<string, unknown>): number | undefined {
	const topProvider = m.top_provider as Record<string, unknown> | undefined;
	return (
		toNumber(m.max_output_tokens) ??
		toNumber(m.max_completion_tokens) ??
		toNumber(m.max_tokens) ??
		toNumber(topProvider?.max_completion_tokens)
	);
}

function detectReasoningFromFields(m: Record<string, unknown>): boolean | undefined {
	const supportedParams = asStringArray(m.supported_parameters);
	if (supportedParams.length > 0) {
		return supportedParams.includes("reasoning") || supportedParams.includes("reasoning_effort");
	}
	for (const key of ["reasoning", "thinking", "enable_thinking", "supports_reasoning"]) {
		const b = toBool(m[key]);
		if (b !== undefined) {
			return b;
		}
	}
	return undefined;
}

/**
 * Infer a model's capabilities from a raw `/v1/models` entry.
 *
 * Precedence (highest first): explicit endpoint-provided fields, then id-based
 * substring inference for well-known families, then safe defaults.
 */
export function inferModelCapabilities(model: Record<string, unknown>): InferredCapabilities {
	const id = (typeof model.id === "string" ? model.id : "").toLowerCase();
	const isNonChat = idMatches(id, NON_CHAT_ID_PATTERNS);

	// ── Vision ────────────────────────────────────────────────────────────────
	let vision = detectVisionFromFields(model);
	if (vision === undefined) {
		vision = !isNonChat && idMatches(id, VISION_ID_PATTERNS);
	}

	// ── Tool calling ────────────────────────────────────────────────────────────
	let toolCalling = detectToolsFromFields(model);
	if (toolCalling === undefined) {
		// Default modern chat models to tool calling so they work with agent mode.
		// Only clearly non-chat models (embeddings, audio, image-gen) are excluded.
		toolCalling = !isNonChat;
	}

	// ── Reasoning ─────────────────────────────────────────────────────────────
	let reasoning = detectReasoningFromFields(model);
	if (reasoning === undefined) {
		reasoning = !isNonChat && idMatches(id, REASONING_ID_PATTERNS);
	}

	return {
		vision,
		toolCalling,
		reasoning,
		contextLength: detectContextLength(model),
		maxOutputTokens: detectMaxOutputTokens(model),
	};
}
