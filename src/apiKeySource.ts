import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { buildFetchNetworkInit, proxyFetch } from "./network";
import { parseApiKeys } from "./keyBalancer";
import { logger } from "./logger";

/**
 * Support for sourcing a provider's API keys from a remote location instead of
 * pasting them inline. A "source" is either an HTTP(S) URL
 * (`https://example.com/apilist.txt`), a `file://` URL
 * (`file:///home/somebody/api.txt`) or a bare absolute filesystem path
 * (`/home/somebody/api.txt`, `C:\keys.txt`).
 *
 * The list is fetched fresh on every chat request so rotating/replacing keys at
 * the source is picked up without touching the extension configuration. The last
 * successfully fetched list is cached in memory purely as a fallback when a
 * later fetch fails, so a transient outage of the source does not break chat.
 */

/** Last successfully fetched key list per source, used only as a fetch fallback. */
const lastGood = new Map<string, string[]>();

/**
 * Decide whether a stored/entered value looks like a remote key source (URL or
 * filesystem path) rather than a literal API key.
 */
export function isApiKeySource(value: string | undefined | null): boolean {
	if (!value) {
		return false;
	}
	const v = value.trim();
	if (!v) {
		return false;
	}
	return (
		/^https?:\/\//i.test(v) ||
		/^file:\/\//i.test(v) ||
		v.startsWith("/") ||
		v.startsWith("~/") ||
		/^[a-zA-Z]:[\\/]/.test(v)
	);
}

/**
 * Fetch the raw key list from a source. Throws on any network/filesystem error
 * so callers can decide whether to fall back to a cached list.
 * @param source URL or filesystem path to read the keys from.
 * @param opts.proxyUrl Optional proxy applied to HTTP(S) sources.
 */
export async function fetchApiKeysFromSource(source: string, opts?: { proxyUrl?: string }): Promise<string[]> {
	const src = (source || "").trim();
	if (!src) {
		return [];
	}

	let text: string;
	if (/^https?:\/\//i.test(src)) {
		const init = buildFetchNetworkInit(opts?.proxyUrl);
		const res = await proxyFetch(src, { ...init, method: "GET" });
		if (!res.ok) {
			throw new Error(`Failed to fetch API keys: [${res.status}] ${res.statusText}`);
		}
		text = await res.text();
	} else {
		// file:// URL or a bare filesystem path.
		let filePath = src;
		if (/^file:\/\//i.test(src)) {
			filePath = fileURLToPath(src);
		} else if (src.startsWith("~/")) {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			filePath = home ? `${home}${src.slice(1)}` : src;
		}
		text = await fs.readFile(filePath, "utf8");
	}

	const keys = parseApiKeys(text);
	if (keys.length > 0) {
		lastGood.set(src, keys);
	}
	return keys;
}

/**
 * Resolve keys from a source, falling back to the last successfully fetched list
 * when the current fetch fails. Never throws; returns an empty array when the
 * source cannot be read and no prior success is cached.
 */
export async function resolveApiKeysFromSource(source: string, opts?: { proxyUrl?: string }): Promise<string[]> {
	const src = (source || "").trim();
	if (!src) {
		return [];
	}
	try {
		return await fetchApiKeysFromSource(src, opts);
	} catch (err) {
		const fallback = lastGood.get(src);
		logger.warn("apiKeySource.fetchFailed", {
			source: src,
			error: err instanceof Error ? err.message : String(err),
			usedFallback: !!fallback,
		});
		return fallback ?? [];
	}
}
