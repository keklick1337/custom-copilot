import * as vscode from "vscode";
import { normalizeUserModels, isZaiHost, safeUrlHost } from "./utils";
import { parseApiKeys } from "./keyBalancer";
import { buildFetchNetworkInit, proxyFetch } from "./network";
import { logger } from "./logger";

/**
 * Z.AI / BigModel Coding Plan quota (ZCode `bigmodelUsageQuotaProvider`):
 * GET {host}/api/monitor/usage/quota/limit with the RAW key in `authorization`
 * (a "Bearer " prefix fails auth). Limits are identified by type+unit+number.
 */

interface QuotaLimit {
	type?: string;
	unit?: number;
	number?: number;
	percentage?: number;
	usage?: number;
	remaining?: number;
	nextResetTime?: number;
}

interface QuotaResponse {
	code?: number;
	success?: boolean;
	msg?: string;
	data?: { level?: string; limits?: QuotaLimit[] };
}

function quotaHost(baseUrl: string): string {
	const host = safeUrlHost(baseUrl);
	return host.endsWith("bigmodel.cn") ? "https://open.bigmodel.cn" : "https://api.z.ai";
}

function describe(limit: QuotaLimit): string | undefined {
	const pct = typeof limit.percentage === "number" ? `${Math.round(limit.percentage)}% used` : undefined;
	const reset =
		typeof limit.nextResetTime === "number" && limit.nextResetTime > 0
			? `resets ${new Date(limit.nextResetTime).toLocaleString()}`
			: undefined;
	let label: string | undefined;
	if (limit.type === "TOKENS_LIMIT" && limit.unit === 3 && limit.number === 5) {
		label = "5-hour prompts";
	} else if (limit.type === "TOKENS_LIMIT" && limit.unit === 6 && limit.number === 1) {
		label = "Weekly prompts";
	} else if (limit.type === "TIME_LIMIT" && limit.unit === 5 && limit.number === 1) {
		label = "Monthly MCP / tools";
	}
	if (!label) {
		return undefined;
	}
	const counts =
		typeof limit.usage === "number" && typeof limit.remaining === "number"
			? `${limit.usage} used / ${limit.remaining} left`
			: undefined;
	return [label, pct, counts, reset].filter(Boolean).join(" · ");
}

/** Command: pick a Z.AI provider and show its Coding Plan usage. */
export async function showZaiQuota(secrets: vscode.SecretStorage): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));
	const providers = new Map<string, string>();
	for (const m of models) {
		if (m.baseUrl && isZaiHost(m.baseUrl) && m.owned_by) {
			providers.set(m.owned_by.toLowerCase(), m.baseUrl);
		}
	}
	if (providers.size === 0) {
		vscode.window.showInformationMessage("No Z.AI / BigModel provider is configured.");
		return;
	}
	const names = [...providers.keys()];
	const provider = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { title: "Z.AI provider" });
	if (!provider) {
		return;
	}
	const keys = parseApiKeys((await secrets.get(`customcopilot.apiKey.${provider}`)) ?? "");
	if (keys.length === 0) {
		vscode.window.showWarningMessage(`No API key stored for "${provider}".`);
		return;
	}
	const url = `${quotaHost(providers.get(provider)!)}/api/monitor/usage/quota/limit`;
	const proxy = config.get<string>("customcopilot.proxyUrl", "").trim() || undefined;
	const lines: string[] = [];
	for (const [i, key] of keys.entries()) {
		const tag = keys.length > 1 ? `Key #${i + 1}: ` : "";
		try {
			const res = await proxyFetch(url, {
				...buildFetchNetworkInit(proxy),
				method: "GET",
				headers: { authorization: key, accept: "application/json" },
			});
			const body = (await res.json().catch(() => ({}))) as QuotaResponse;
			if (!res.ok || body.success === false) {
				lines.push(`${tag}unavailable (${res.status}${body.msg ? `: ${body.msg}` : ""}) — not a Coding Plan key?`);
				continue;
			}
			const level = body.data?.level ? `${body.data.level.toUpperCase()} plan` : "plan";
			const parts = (body.data?.limits ?? []).map(describe).filter((s): s is string => !!s);
			lines.push(`${tag}${level}${parts.length ? `\n  ${parts.join("\n  ")}` : ""}`);
		} catch (err) {
			logger.warn("zai.quota.error", { error: err instanceof Error ? err.message : String(err) });
			lines.push(`${tag}request failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	vscode.window.showInformationMessage(`Z.AI quota (${provider})`, { modal: true, detail: lines.join("\n\n") });
}
