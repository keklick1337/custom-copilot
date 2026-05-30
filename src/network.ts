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

export function buildFetchNetworkInit(proxyUrl?: string): RequestInit {
	let resolved: string | undefined;
	if (proxyUrl !== undefined) {
		const p = proxyUrl.trim().toLowerCase();
		if (p === "none" || p === "direct" || p === "no-proxy" || p === "no_proxy" || p === "") {
			resolved = undefined;
		} else {
			resolved = proxyUrl;
		}
	} else {
		// Fallback to global config
		try {
			const config = vscode.workspace.getConfiguration();
			const globalProxy = config.get<string>("customcopilot.proxyUrl", "").trim();
			const gp = globalProxy.toLowerCase();
			if (gp === "none" || gp === "direct" || gp === "no-proxy" || gp === "no_proxy" || gp === "") {
				resolved = undefined;
			} else {
				resolved = globalProxy;
			}
		} catch {
			resolved = undefined;
		}
	}

	const dispatcher = getProxyDispatcher(resolved);
	if (!dispatcher) {
		return {};
	}
	return { dispatcher } as RequestInit;
}
