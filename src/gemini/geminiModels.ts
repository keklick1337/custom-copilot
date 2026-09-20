import type { CustomModelItem } from "../types";
import { CommonApi } from "../commonApi";
import { buildFetchNetworkInit, proxyFetch } from "../network";
import { buildGeminiModelsUrl, normalizeGeminiModelIdForListing } from "./geminiUrls";

/**
 * Fetch available models from a Gemini API endpoint.
 * Supports both native Google Gemini and Langdock Google proxy endpoints.
 * @param baseUrl The Gemini API base URL.
 * @param apiKey The API key for authentication.
 * @param customHeaders Optional custom headers to merge with defaults.
 * @returns A promise that resolves to an array of model items.
 */
export async function fetchGeminiModels(
	baseUrl: string,
	apiKey: string,
	customHeaders?: Record<string, string>,
	networkOptions?: { proxyUrl?: string; userAgent?: string }
): Promise<CustomModelItem[]> {
	const listUrl = buildGeminiModelsUrl(baseUrl);
	const ownedBy = baseUrl.includes("langdock.com") ? "langdock" : "google";
	const headers = CommonApi.prepareHeaders(apiKey, "gemini", customHeaders, networkOptions?.userAgent);
	headers["Accept"] = "application/json";
	const networkInit = buildFetchNetworkInit(networkOptions?.proxyUrl);

	const models: CustomModelItem[] = [];
	let nextPageToken: string | undefined;
	let page = 0;

	while (page < 10) {
		const url = new URL(listUrl);
		if (nextPageToken) {
			url.searchParams.set("pageToken", nextPageToken);
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
				`Gemini API error: [${resp.status}] ${resp.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${url.toString()}`
			);
		}

		const parsed = (await resp.json()) as import("./geminiTypes").GeminiModelListResponse;
		const entries = parsed.models ?? [];
		for (const entry of entries) {
			const id = normalizeGeminiModelIdForListing(entry.name, entry.displayName);
			models.push({
				id,
				displayName: entry.displayName || id,
				owned_by: ownedBy,
				context_length: entry.inputTokenLimit,
				max_completion_tokens: entry.outputTokenLimit,
				apiMode: "gemini",
			} as CustomModelItem);
		}

		nextPageToken = parsed.nextPageToken;
		if (!nextPageToken) {
			break;
		}
		page += 1;
	}

	return models;
}
