/**
 * URL construction and id normalization helpers for the Gemini adapter.
 * Shared between the streaming adapter (geminiApi.ts) and the model
 * listing (geminiModels.ts).
 */

export function normalizeBaseUrl(raw: string): string {
	const v = (raw || "").trim();
	if (!v) {
		return "";
	}
	try {
		return new URL(v).toString();
	} catch {
		// Try to recover from missing scheme
		if (!/^https?:\/\//i.test(v)) {
			try {
				return new URL(`https://${v}`).toString();
			} catch {
				return v;
			}
		}
		return v;
	}
}

export function joinPathPrefix(basePath: string, nextPath: string): string {
	const a = basePath || "";
	const b = nextPath || "";
	const aTrim = a.endsWith("/") ? a.slice(0, -1) : a;
	const bTrim = b.startsWith("/") ? b : `/${b}`;
	return `${aTrim || ""}${bTrim}`;
}

/**
 * Build the Gemini models list endpoint URL from a base URL.
 * Handles various baseUrl formats: bare domain, /v1beta, or /v1beta/models.
 * @param baseUrl The base URL to normalize.
 * @returns The full models list endpoint URL.
 */
export function buildGeminiModelsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/v1beta/models")) {
		return trimmed;
	}
	if (trimmed.endsWith("/v1beta")) {
		return `${trimmed}/models`;
	}
	return `${trimmed}/v1beta/models`;
}

/**
 * Normalize a Gemini model identifier by stripping the "models/" prefix.
 * @param name The model name from the API response.
 * @param displayName The display name from the API response.
 * @returns A normalized model ID suitable for user configuration.
 */
export function normalizeGeminiModelIdForListing(name?: string, displayName?: string): string {
	if (name && name.trim()) {
		if (name.startsWith("models/")) {
			return name.slice("models/".length);
		}
		return name;
	}
	return displayName?.trim() || "unknown";
}

export function normalizeGeminiModelPath(modelId: string): string {
	const raw = (modelId || "").trim();
	if (!raw) {
		return "models/gemini-3-pro-preview";
	}

	const last = raw.includes("/") ? raw.split("/").filter(Boolean).pop() || raw : raw;
	if (last.startsWith("models/") || last.startsWith("tunedModels/")) {
		return last;
	}

	if (last.includes("..") || last.includes("?") || last.includes("&")) {
		return "";
	}

	return `models/${last}`;
}

export function buildGeminiGenerateContentUrl(rawBaseUrl: string, modelId: string, stream: boolean): string {
	const value = (rawBaseUrl || "").trim();
	if (!value) {
		return "";
	}

	try {
		const normalized = normalizeBaseUrl(value);
		const u0 = new URL(normalized);
		let basePath = (u0.pathname || "").replace(/\/+$/, "") || "/";

		// If configured as a full endpoint, keep it (just switch method based on stream).
		if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
			const method = stream ? "streamGenerateContent" : "generateContent";
			u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
			u0.search = "";
			u0.hash = "";
			if (stream) {
				u0.searchParams.set("alt", "sse");
			}
			return u0.toString();
		}

		const modelPath = normalizeGeminiModelPath(modelId);
		if (!modelPath) {
			return "";
		}

		// If base already contains a version segment, don't append again.
		if (!/\/v1beta$/i.test(basePath) && !/\/v1beta\//i.test(`${basePath}/`)) {
			basePath = joinPathPrefix(basePath, "/v1beta");
		}

		const method = stream ? "streamGenerateContent" : "generateContent";
		u0.pathname = joinPathPrefix(basePath, `/${modelPath}:${method}`);
		u0.search = "";
		u0.hash = "";
		if (stream) {
			u0.searchParams.set("alt", "sse");
		}
		return u0.toString();
	} catch {
		return "";
	}
}
