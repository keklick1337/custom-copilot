import * as vscode from "vscode";
import type { Dispatcher } from "undici";
import { ProxyAgent } from "undici";

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
	if (!/^socks5:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
		throw new Error("Invalid proxy URL. Use socks5://, http:// or https://");
	}
	return value;
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
