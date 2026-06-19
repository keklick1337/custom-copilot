import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation } from "vscode";

import type { HFApiMode, HFModelItem, HFModelsResponse } from "./types";
import { normalizeUserModels } from "./utils";
import { VersionManager } from "./versionManager";
import { fetchGeminiModels } from "./gemini/geminiApi";
import { fetchOllamaModels } from "./ollama/ollamaApi";
import { fetchAnthropicModels } from "./anthropic/anthropicApi";
import { logger } from "./logger";
import { buildFetchNetworkInit, proxyFetch } from "./network";
import { inferModelCapabilities } from "./modelCapabilities";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const EXTENSION_LABEL = "customcopilot";

function formatContextSize(tokens?: number): string {
	if (!tokens) {
		return "128k context";
	}
	if (tokens >= 1000000) {
		return `${(tokens / 1000000).toFixed(1).replace(/\.0$/, "")}M context`;
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(0)}k context`;
	}
	return `${tokens} context`;
}

function getProviderLabel(m: HFModelItem): string {
	if (m.owned_by) {
		return m.owned_by.charAt(0).toUpperCase() + m.owned_by.slice(1);
	}
	if (m.apiMode) {
		return m.apiMode.charAt(0).toUpperCase() + m.apiMode.slice(1);
	}
	return "Custom";
}

/**
 * Get the list of available language models contributed by this provider
 * @param options Options which specify the calling context of this function
 * @param token A cancellation token which signals if the user cancelled the request or not
 * @returns A promise that resolves to the list of available language models
 */
export async function prepareLanguageModelChatInformation(
	options: { silent: boolean; apiMode?: HFApiMode },
	_token: CancellationToken,
	_secrets: vscode.SecretStorage
): Promise<LanguageModelChatInformation[]> {
	// Check for user-configured models first
	const config = vscode.workspace.getConfiguration();
	const userModels = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

	// When this provider instance is bound to a specific vendor (apiMode), only
	// surface models for that protocol so each vendor renders as its own group in
	// the model picker. Models default to the "openai" protocol when unspecified.
	const vendorMode = options.apiMode;
	const matchesVendor = (m: HFModelItem): boolean => !vendorMode || (m.apiMode ?? "openai") === vendorMode;

	let infos: LanguageModelChatInformation[];
	const scopedModels = userModels?.filter((m) => !m.id.startsWith("__provider__") && matchesVendor(m)) ?? [];
	if (scopedModels.length > 0) {
		// Return user-provided models directly
		infos = scopedModels.map((m) => {
			const contextLen = m?.context_length ?? DEFAULT_CONTEXT_LENGTH;
			const maxOutput = m?.max_completion_tokens ?? m?.max_tokens ?? DEFAULT_MAX_TOKENS;
			const maxInput = Math.max(1, contextLen - maxOutput);

			// 使用配置ID（如果存在）来生成唯一的模型ID
			const modelId = m.configId ? `${m.id}::${m.configId}` : m.id;
			const modelName = m.displayName || (m.configId ? `${m.id}::${m.configId}` : `${m.id}`);

			const provider = getProviderLabel(m);
			const contextText = formatContextSize(contextLen);
			const caps: string[] = [];
			if (m.tool_calling || m.extra?.tool_calling) {
				caps.push("tools");
			}
			if (m.vision) {
				caps.push("vision");
			}
			if (m.enable_thinking || m.thinking || m.reasoning_effort || m.reasoning?.enabled) {
				caps.push("thinking");
			}
			const capsText = caps.length > 0 ? ` • ${caps.join(", ")}` : "";
			const detail = `${provider} (${EXTENSION_LABEL}) • ${contextText}${capsText}`;
			const tooltip = `Model: ${modelName}\nProvider: ${provider}\nContext: ${contextText}\nCapabilities: ${caps.join(", ") || "none"}`;

			return {
				id: modelId,
				name: modelName,
				detail: detail,
				tooltip: tooltip,
				family: m.family ?? EXTENSION_LABEL,
				version: "1.0.0",
				maxInputTokens: maxInput,
				maxOutputTokens: maxOutput,
				isUserSelectable: true,
				capabilities: {
					toolCalling: m?.tool_calling === true,
					imageInput: m?.vision ?? false,
				},
			} satisfies LanguageModelChatInformation;
		});
	} else {
		// User has models configured but none belong to this vendor's protocol.
		infos = [];
	}

	logger.info("models.loaded", {
		count: infos.length,
		source: scopedModels.length > 0 ? "config" : "api",
		apiMode: vendorMode ?? "all",
	});
	return infos;
}

/**
 * Fetch the list of models and supplementary metadata from Provider.
 */
export async function fetchModels(
	baseUrl: string,
	apiKey: string,
	apiMode?: HFApiMode | string,
	customHeaders?: Record<string, string>,
	networkOptions?: { proxyUrl?: string; userAgent?: string }
): Promise<{ models: HFModelItem[] }> {
	const normalizedApiMode = apiMode ?? "openai";
	const userAgent = (networkOptions?.userAgent || "").trim() || VersionManager.getUserAgent();
	const networkInit = buildFetchNetworkInit(networkOptions?.proxyUrl);
	if (normalizedApiMode === "gemini") {
		const models = await fetchGeminiModels(baseUrl, apiKey, customHeaders, networkOptions);
		return { models };
	} else if (normalizedApiMode === "ollama") {
		const models = await fetchOllamaModels(baseUrl, apiKey, customHeaders, networkOptions);
		return { models };
	} else if (normalizedApiMode === "anthropic" || normalizedApiMode === "zai") {
		const models = await fetchAnthropicModels(baseUrl, apiKey, customHeaders, networkOptions, normalizedApiMode);
		return { models };
	}

	const modelsList = (async () => {
		const baseHeaders: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"User-Agent": userAgent,
		};
		const headers = customHeaders ? { ...baseHeaders, ...customHeaders } : baseHeaders;
		const resp = await proxyFetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			...networkInit,
			method: "GET",
			headers,
		});
		if (!resp.ok) {
			let text = "";
			try {
				text = await resp.text();
			} catch (error) {
				console.error("[customcopilot] Failed to read response text", error);
			}
			const err = new Error(`Failed to fetch models: ${resp.status} ${resp.statusText}${text ? `\n${text}` : ""}`);
			console.error("[customcopilot] Failed to fetch models", err);
			throw err;
		}
		const parsed = (await resp.json()) as HFModelsResponse;
		return parsed.data ?? [];
	})();

	try {
		const apiModels = await modelsList;

		// Convert APIModelItem to HFModelItem
		const models: HFModelItem[] = apiModels.map((apiModel) => {
			// Infer capabilities (vision, tools, context, reasoning) from any rich
			// fields the endpoint exposes, falling back to model-id inference and
			// safe defaults. Mirrors VS Code's BYOK capability resolution but is
			// robust for plain OpenAI-compatible endpoints that advertise nothing.
			const inferred = inferModelCapabilities(apiModel as unknown as Record<string, unknown>);
			const vision = inferred.vision;
			const hasToolFeatures = inferred.toolCalling;

			// Use the inferred context length (covers context_size/context_length/etc.)
			const contextLength = inferred.contextLength;

			// Use the inferred max output tokens (covers max_output_tokens/max_tokens/etc.)
			const maxTokens = inferred.maxOutputTokens;

			// Create the HFModelItem
			const hfModel: HFModelItem = {
				id: apiModel.id,
				object: apiModel.object,
				created: apiModel.created,
				owned_by: apiModel.owned_by,
				displayName: apiModel.display_name || apiModel.title,
				context_length: contextLength,
				vision: vision,
				tool_calling: hasToolFeatures,
				max_tokens: maxTokens,
				// Preserve other fields that exist in both interfaces
				configId: apiModel.configId,
				baseUrl: apiModel.baseUrl,
				providers: apiModel.providers,
				architecture: apiModel.architecture,
				reasoning_effort: apiModel.reasoning_effort,
				enable_thinking: apiModel.enable_thinking,
				thinking_budget: apiModel.thinking_budget,
				thinking: apiModel.thinking,
				temperature: apiModel.temperature,
				top_p: apiModel.top_p,
				top_k: apiModel.top_k,
				min_p: apiModel.min_p,
				frequency_penalty: apiModel.frequency_penalty,
				presence_penalty: apiModel.presence_penalty,
				repetition_penalty: apiModel.repetition_penalty,
				reasoning: apiModel.reasoning,
				family: apiModel.family,
				extra: apiModel.extra,
				headers: apiModel.headers,
				include_reasoning_in_request: apiModel.include_reasoning_in_request,
				apiMode: apiModel.apiMode,
				useForCommitGeneration: apiModel.useForCommitGeneration,
				delay: apiModel.delay,
			};

			return hfModel;
		});

		return { models };
	} catch (err) {
		const errorObj = err instanceof Error ? err : new Error(String(err));
		console.error("[customcopilot] Failed to fetch models", err);
		logger.error("models.fetch.error", { baseUrl, error: errorObj.message });
		throw err;
	}
}

/**
 * Fetch models for a pool of API keys and return only the models available on
 * **every** key (the intersection by model id). This guarantees that any model
 * the user adds for a load-balanced provider can be served by all of its keys.
 *
 * @param baseUrl API base URL.
 * @param apiKeys One or more API keys to probe.
 * @param apiMode Request protocol.
 * @param customHeaders Extra HTTP headers.
 * @param networkOptions Proxy / user-agent overrides.
 * @returns The intersected models plus the per-key probe results for UI feedback.
 */
export async function fetchModelsIntersection(
	baseUrl: string,
	apiKeys: string[],
	apiMode?: HFApiMode | string,
	customHeaders?: Record<string, string>,
	networkOptions?: { proxyUrl?: string; userAgent?: string }
): Promise<{ models: HFModelItem[]; keyResults: { ok: boolean; error?: string }[] }> {
	const keys = apiKeys.filter((key) => key && key.trim()).map((key) => key.trim());
	if (keys.length <= 1) {
		const { models } = await fetchModels(baseUrl, keys[0] ?? "", apiMode, customHeaders, networkOptions);
		return { models, keyResults: [{ ok: true }] };
	}

	const settled = await Promise.allSettled(
		keys.map((key) => fetchModels(baseUrl, key, apiMode, customHeaders, networkOptions))
	);

	const keyResults: { ok: boolean; error?: string }[] = settled.map((result) =>
		result.status === "fulfilled"
			? { ok: true }
			: { ok: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
	);

	const successful = settled
		.filter((result): result is PromiseFulfilledResult<{ models: HFModelItem[] }> => result.status === "fulfilled")
		.map((result) => result.value.models);

	if (successful.length === 0) {
		// Surface the first error so the UI can report why discovery failed.
		const firstError = keyResults.find((result) => !result.ok)?.error ?? "Failed to fetch models";
		throw new Error(firstError);
	}

	// Intersect by model id: keep models present in every successful key response.
	const [first, ...rest] = successful;
	const intersected = first.filter((model) => rest.every((list) => list.some((other) => other.id === model.id)));

	return { models: intersected, keyResults };
}
