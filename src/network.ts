import * as vscode from "vscode";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

const proxyAgentCache = new Map<string, Dispatcher>();

function normalizeProxyUrl(proxyUrl?: string): string {
	const value = (proxyUrl || "").trim();
	if (!value) {
		return "";
	}
	const lowerValue = value.toLowerCase();
	if (lowerValue === "none" || lowerValue === "direct" || lowerValue === "no-proxy" || lowerValue === "no_proxy") {
		return "";
	}
	// undici's ProxyAgent only recognises the `socks5:`/`socks:` scheme. It already
	// performs remote DNS for hostnames (SOCKS5 ATYP=DOMAIN), so a `socks5h://`
	// URL (the Tor convention for "resolve at the proxy") is functionally identical.
	// Normalise it to `socks5://` instead of rejecting it, which is a common trap.
	let normalized = value;
	if (/^socks5h:\/\//i.test(value)) {
		normalized = "socks5://" + value.slice("socks5h://".length);
	}
	if (!/^socks5:\/\//i.test(normalized) && !/^https?:\/\//i.test(normalized)) {
		throw new Error("Invalid proxy URL. Use socks5://, socks5h://, http:// or https://");
	}
	return normalized;
}

export function getProxyDispatcher(proxyUrl?: string): Dispatcher | undefined {
	const normalized = normalizeProxyUrl(proxyUrl);
	if (!normalized) {
		return undefined;
	}
	const existing = proxyAgentCache.get(normalized);
	if (existing) {
		return existing;
	}
	const created = new ProxyAgent(normalized);
	proxyAgentCache.set(normalized, created);
	return created;
}

function isDirectProxyToken(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === "none" || v === "direct" || v === "no-proxy" || v === "no_proxy";
}

function readGlobalProxyUrl(): string | undefined {
	try {
		const config = vscode.workspace.getConfiguration();
		const globalProxy = config.get<string>("customcopilot.proxyUrl", "").trim();
		if (!globalProxy || isDirectProxyToken(globalProxy)) {
			return undefined;
		}
		return globalProxy;
	} catch {
		return undefined;
	}
}

export function buildFetchNetworkInit(proxyUrl?: string): RequestInit {
	let resolved: string | undefined;
	const trimmed = (proxyUrl ?? "").trim();
	if (isDirectProxyToken(trimmed)) {
		// Explicit opt-out: force a direct connection, ignoring the global proxy.
		resolved = undefined;
	} else if (trimmed) {
		// A concrete per-call proxy was provided.
		resolved = trimmed;
	} else {
		// Not specified (undefined or blank): fall back to the global proxy config.
		resolved = readGlobalProxyUrl();
	}

	const dispatcher = getProxyDispatcher(resolved);
	if (!dispatcher) {
		return {};
	}
	return { dispatcher } as RequestInit;
}

/**
 * Fetch that actually honours the per-request `dispatcher` (ProxyAgent).
 *
 * IMPORTANT: VS Code's extension host REPLACES `globalThis.fetch` with its own
 * wrapper (see `vs/workbench/api/node/proxyResolver.ts → patchGlobalFetch`).
 * That wrapper routes through VS Code's own `http.proxy`/`http.proxySupport`
 * settings and SILENTLY DROPS the undici `dispatcher` option we attach in
 * `buildFetchNetworkInit`. As a result, a socks5 proxy configured in
 * `customcopilot.proxyUrl` (or per-model `proxyUrl`) is ignored and every
 * request goes direct / via VS Code's proxy — the "proxy not recognised" bug.
 *
 * Calling undici's own `fetch` directly bypasses the patched global, so the
 * `dispatcher` is respected and socks5/http/https proxies work for ALL of a
 * provider's requests (model discovery, chat, commit generation, key tests).
 *
 * The returned object is structurally a standard `Response` (`.ok`, `.status`,
 * `.statusText`, `.text()`, `.json()`, `.body` ReadableStream) — undici's
 * Response implements the web spec, so existing call sites work unchanged.
 */
export async function proxyFetch(
	input: string | URL | Request,
	init?: RequestInit & { dispatcher?: Dispatcher }
): Promise<Response> {
	// Cast through unknown: undici's RequestInit/Response types differ slightly
	// from the DOM lib types, but the runtime shapes are compatible.
	return undiciFetch(input as Parameters<typeof undiciFetch>[0], init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
