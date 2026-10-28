import type { CustomApiMode } from "./types";

/**
 * Single source of truth for the vendor list: vendor id (must match
 * package.json → contributes.languageModelChatProviders), its apiMode, the
 * picker display name and the default base URL advertised to VS Code's BYOK
 * group UI. Shared by the extension entry and the configuration webview host
 * (which needs vendor ids to build chat model selectors).
 */
export const VENDOR_MODES: ReadonlyArray<{
	vendor: string;
	mode: CustomApiMode;
	displayName: string;
	defaultBaseUrl: string;
}> = [
	{ vendor: "copilotcustommodelsendpoint", mode: "openai", displayName: "Custom OpenAI", defaultBaseUrl: "https://api.openai.com/v1" },
	{ vendor: "copilotcustommodelsendpoint-responses", mode: "openai-responses", displayName: "Custom OpenAI Responses", defaultBaseUrl: "https://api.openai.com/v1" },
	{ vendor: "copilotcustommodelsendpoint-anthropic", mode: "anthropic", displayName: "Custom Anthropic", defaultBaseUrl: "https://api.anthropic.com/v1" },
	{ vendor: "copilotcustommodelsendpoint-gemini", mode: "gemini", displayName: "Custom Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
	{ vendor: "copilotcustommodelsendpoint-ollama", mode: "ollama", displayName: "Custom Ollama", defaultBaseUrl: "http://localhost:11434" },
	{ vendor: "copilotcustommodelsendpoint-zai", mode: "zai", displayName: "Z.AI (Anthropic-compat)", defaultBaseUrl: "https://api.z.ai/api/anthropic" },
];

/** Vendor id serving the given apiMode (models default to the "openai" protocol). */
export function vendorForApiMode(apiMode?: CustomApiMode | string): string {
	const mode = apiMode || "openai";
	return (VENDOR_MODES.find((v) => v.mode === mode) ?? VENDOR_MODES[0]).vendor;
}
