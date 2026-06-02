import * as vscode from "vscode";
import type { HFApiMode, HFModelItem } from "../types";
import { normalizeUserModels, parseModelId, resolveProxyUrl } from "../utils";
import { fetchModels, fetchModelsIntersection } from "../provideModel";
import { parseApiKeys } from "../keyBalancer";
import { CommonApi } from "../commonApi";
import { buildFetchNetworkInit } from "../network";
import { VersionManager } from "../versionManager";
import { getChatRequestStartCount, waitForChatRequestStart } from "../chatActivity";

interface InitPayload {
	proxyUrl: string;
	userAgent: string;
	delay: number;
	readFileLines: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	commitModel: string;
	commitLanguage: string;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
	allowAnonymousAccess: boolean;
	restoreChatSessions: boolean;
	telemetryDisabled: boolean;
	chatRetries: number;
	chatRetryInterval: number;
	chatRetryJitter: number;
}

interface ExportConfig {
	version: string;
	exportDate: string;
	proxyUrl: string;
	delay: number;
	retry: {
		enabled?: boolean;
		max_attempts?: number;
		interval_ms?: number;
		status_codes?: number[];
	};
	commitLanguage: string;
	commitModel: string;
	models: HFModelItem[];
	providerKeys: Record<string, string>;
	readFileLines: number;
}

type IncomingMessage =
	| { type: "requestInit" }
	| {
			type: "saveGlobalConfig";
			baseUrl: string;
			proxyUrl: string;
			userAgent: string;
			delay: number;
			readFileLines: number;
			retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] };
			commitModel: string;
			commitLanguage: string;
	  }
	| {
			type: "fetchModels";
			baseUrl: string;
			apiKey: string;
			apiMode?: HFApiMode | string;
			headers?: Record<string, string>;
			proxyUrl?: string;
			userAgent?: string;
	  }
	| {
			type: "testModelKeys";
			baseUrl: string;
			apiKey: string;
			apiMode?: HFApiMode | string;
			modelId: string;
			headers?: Record<string, string>;
			proxyUrl?: string;
			userAgent?: string;
	  }
	| {
			type: "refreshModelsFromApi";
			baseUrl: string;
			apiKey: string;
			proxyUrl?: string;
			userAgent?: string;
	  }
	| {
			type: "addProvider";
			provider: string;
			baseUrl?: string;
			apiKey?: string;
			apiMode?: string;
			headers?: Record<string, string>;
			proxyUrl?: string;
			userAgent?: string;
			delay?: number;
	  }
	| {
			type: "updateProvider";
			provider: string;
			baseUrl?: string;
			apiKey?: string;
			apiMode?: string;
			headers?: Record<string, string>;
			proxyUrl?: string;
			userAgent?: string;
			delay?: number;
	  }
	| { type: "deleteProvider"; provider: string }
	| { type: "addModel"; model: HFModelItem }
	| { type: "updateModel"; model: HFModelItem; originalModelId?: string; originalConfigId?: string }
	| { type: "deleteModel"; modelId: string }
	| { type: "deleteModels"; modelIds: string[] }
	| { type: "importModels"; models: HFModelItem[]; provider: string }
	| { type: "saveCommitSettings"; commitModel: string; commitLanguage: string }
	| { type: "requestConfirm"; id: string; message: string; action: string }
	| { type: "setAnonymousAccess"; enabled: boolean }
	| { type: "setRestoreChatSessions"; enabled: boolean }
	| { type: "setTelemetryDisabled"; disabled: boolean }
	| { type: "setChatRetries"; value: number }
	| { type: "setChatRetryInterval"; value: number }
	| { type: "setChatRetryJitter"; value: number }
	| {
			type: "launchChats";
			prompts: string[];
			mode?: string;
			modelFullId?: string;
			strategy?: "sequential" | "parallel";
			delayMs?: number;
	  }
	| { type: "prefillChat"; prompt: string; mode?: string; modelFullId?: string }
	| { type: "exportConfig" }
	| { type: "importConfig" };

type OutgoingMessage =
	| { type: "init"; payload: InitPayload }
	| { type: "modelsFetched"; models: HFModelItem[] }
	| { type: "confirmResponse"; id: string; confirmed: boolean };

export class ConfigViewController {
	private readonly webview: vscode.Webview;
	private readonly extensionUri: vscode.Uri;
	private readonly secrets: vscode.SecretStorage;
	private disposables: vscode.Disposable[] = [];

	constructor(webview: vscode.Webview, extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		this.webview = webview;
		this.extensionUri = extensionUri;
		this.secrets = secrets;

		this.update();

		this.webview.onDidReceiveMessage(
			async (message) => {
				this.handleMessage(message).catch((err) => {
					console.error("[customcopilot] handleMessage failed", err);
					vscode.window.showErrorMessage(
						err instanceof Error
							? err.message
							: `Unexpected error while handling configuration message[${message.type}].`
					);
				});
			},
			null,
			this.disposables
		);

		// Send initialization data
		this.sendInit();
	}

	public async update() {
		this.webview.html = await this.getHtml(this.webview);
	}

	public dispose() {
		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	async handleMessage(message: IncomingMessage) {
		switch (message.type) {
			case "requestInit":
				await this.sendInit();
				break;
			case "saveGlobalConfig":
				await this.saveGlobalConfig(
					message.baseUrl,
					message.proxyUrl,
					message.userAgent,
					message.delay,
					message.readFileLines,
					message.retry,
					message.commitModel,
					message.commitLanguage
				);
				break;
			case "fetchModels": {
				try {
					const apiKeys = parseApiKeys(message.apiKey);
					const { models, keyResults } = await fetchModelsIntersection(
						message.baseUrl,
						apiKeys.length ? apiKeys : [message.apiKey],
						message.apiMode,
						message.headers,
						{
							proxyUrl: message.proxyUrl,
							userAgent: message.userAgent,
						}
					);
					this.webview.postMessage({ type: "modelsFetched", models, keyResults });
				} catch (err) {
					console.error("[customcopilot] fetchModels failed", err);
					const errorMessage = err instanceof Error ? err.message : String(err);
					this.webview.postMessage({ type: "modelsFetchError", error: errorMessage });
				}
				break;
			}
			case "refreshModelsFromApi":
				await this.refreshModelsFromApi(message.baseUrl, message.apiKey, message.proxyUrl, message.userAgent);
				break;
			case "testModelKeys":
				await this.testModelKeys(
					message.baseUrl,
					message.apiKey,
					message.modelId,
					message.apiMode,
					message.headers,
					message.proxyUrl,
					message.userAgent
				);
				break;
			case "addProvider":
				await this.addProvider(
					message.provider,
					message.baseUrl,
					message.apiKey,
					message.apiMode,
					message.headers,
					message.proxyUrl,
					message.userAgent,
					message.delay
				);
				break;
			case "updateProvider":
				await this.updateProvider(
					message.provider,
					message.baseUrl,
					message.apiKey,
					message.apiMode,
					message.headers,
					message.proxyUrl,
					message.userAgent,
					message.delay
				);
				break;
			case "deleteProvider":
				await this.deleteProvider(message.provider);
				break;
			case "addModel":
				await this.addModel(message.model);
				break;
			case "updateModel":
				await this.updateModel(message.model, message.originalModelId, message.originalConfigId);
				break;
			case "requestConfirm":
				await this.handleConfirmRequest(message.id, message.message, message.action);
				break;
			case "deleteModel":
				await this.deleteModel(message.modelId);
				break;
			case "deleteModels":
				await this.deleteModels(message.modelIds);
				break;
			case "importModels":
				await this.importModels(message.models, message.provider);
				break;
			case "saveCommitSettings":
				await this.saveCommitSettings(message.commitModel, message.commitLanguage);
				break;
			case "setAnonymousAccess":
				await this.setAnonymousAccess(message.enabled);
				break;
			case "setRestoreChatSessions":
				await this.setRestoreChatSessions(message.enabled);
				break;
			case "setTelemetryDisabled":
				await this.setTelemetryDisabled(message.disabled);
				break;
			case "setChatRetries":
				await this.setChatRetries(message.value);
				break;
			case "setChatRetryInterval":
				await this.setChatRetryInterval(message.value);
				break;
			case "setChatRetryJitter":
				await this.setChatRetryJitter(message.value);
				break;
			case "launchChats":
				await this.launchChats(
					message.prompts,
					message.mode,
					message.modelFullId,
					message.strategy ?? "sequential",
					message.delayMs ?? 1500
				);
				break;
			case "prefillChat":
				await this.prefillChat(message.prompt, message.mode, message.modelFullId);
				break;
			case "exportConfig":
				await this.exportConfig();
				break;
			case "importConfig":
				await this.importConfig();
				break;
			default:
				break;
		}
	}

	private async handleConfirmRequest(id: string, message: string, action: string) {
		let confirmed: boolean | string | undefined;

		if (action === "showInfo") {
			// For informational messages, just show the message without confirmation
			await vscode.window.showInformationMessage(message);
			confirmed = true;
		} else {
			// For confirmation requests, show Yes/No dialog
			confirmed = await vscode.window.showInformationMessage(message, { modal: true }, "Yes", "No");
		}

		// Send response back to webview
		this.webview.postMessage({
			type: "confirmResponse",
			id: id,
			confirmed: action === "showInfo" ? true : confirmed === "Yes",
		} as OutgoingMessage);
	}

	public async sendInit() {
		const config = vscode.workspace.getConfiguration();
		const proxyUrl = config.get<string>("customcopilot.proxyUrl", "");
		const userAgent = config.get<string>(
			"customcopilot.userAgent",
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
		);
		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

		const providerKeys: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const normalized = provider.toLowerCase();
			let key = await this.secrets.get(`customcopilot.apiKey.${normalized}`);
			if (!key && normalized !== provider) {
				// Backward compat: previous versions stored provider keys with original casing.
				const legacy = await this.secrets.get(`customcopilot.apiKey.${provider}`);
				if (legacy) {
					key = legacy;
					await this.secrets.store(`customcopilot.apiKey.${normalized}`, legacy);
					await this.secrets.delete(`customcopilot.apiKey.${provider}`);
				}
			}
			if (key) {
				providerKeys[provider] = key;
			}
		}

		const delay = config.get<number>("customcopilot.delay", 0);
		const retry = config.get<{
			enabled?: boolean;
			max_attempts?: number;
			interval_ms?: number;
			status_codes?: number[];
		}>("customcopilot.retry", {
			enabled: true,
			max_attempts: 3,
			interval_ms: 1000,
		});

		const foundModel = models.find((model) => model.useForCommitGeneration === true);
		const commitModel = foundModel ? `${foundModel.id}${foundModel.configId ? "::" + foundModel.configId : ""}` : "";
		const commitLanguage = config.get<string>("customcopilot.commitLanguage", "English");
		const readFileLines = config.get<number>("customcopilot.readFileLines", 0);
		const allowAnonymousAccess = config.get<boolean>("chat.allowAnonymousAccess", false);
		const restoreChatSessions = config.get<boolean>("chat.restoreLastPanelSession", false);
		const telemetryDisabled = config.get<string>("telemetry.telemetryLevel", "all") === "off";
		const chatRetries = config.get<number>("customcopilot.chatRetries", 0);
		const chatRetryInterval = config.get<number>("customcopilot.chatRetryInterval", 1000);
		const chatRetryJitter = config.get<number>("customcopilot.chatRetryJitter", 0);
		const payload: InitPayload = {
			proxyUrl,
			userAgent,
			delay,
			readFileLines,
			retry,
			commitModel,
			commitLanguage,
			models,
			providerKeys,
			allowAnonymousAccess,
			restoreChatSessions,
			telemetryDisabled,
			chatRetries,
			chatRetryInterval,
			chatRetryJitter,
		};
		this.webview.postMessage({ type: "init", payload });
	}

	/**
	 * Run a minimal "hello world" request against every API key configured for a
	 * provider so the UI can show a per-key pass/fail indicator. Keys are tested
	 * in parallel; the result preserves the key order (one entry per key line).
	 */
	private async testModelKeys(
		baseUrl: string,
		apiKey: string,
		modelId: string,
		apiMode?: HFApiMode | string,
		headers?: Record<string, string>,
		proxyUrl?: string,
		userAgent?: string
	) {
		const keys = parseApiKeys(apiKey);
		const effectiveBaseUrl = (baseUrl || "").trim().replace(/\/+$/, "");
		const mode = (apiMode as string) || "openai";
		const config = vscode.workspace.getConfiguration();
		const effectiveProxyUrl = resolveProxyUrl((proxyUrl || "").trim(), config.get<string>("customcopilot.proxyUrl", "").trim());
		const networkInit = buildFetchNetworkInit(effectiveProxyUrl);

		const buildRequest = (): { url: string; body: Record<string, unknown> } => {
			if (mode === "anthropic") {
				return {
					url: `${effectiveBaseUrl}/messages`,
					// max_tokens is required by the Anthropic API.
					body: { model: modelId, max_tokens: 64, messages: [{ role: "user", content: "Hello world" }] },
				};
			}
			if (mode === "ollama") {
				return {
					url: `${effectiveBaseUrl}/api/chat`,
					body: { model: modelId, messages: [{ role: "user", content: "Hello world" }], stream: false },
				};
			}
			if (mode === "gemini") {
				return {
					url: `${effectiveBaseUrl}/models/${encodeURIComponent(modelId)}:generateContent`,
					body: { contents: [{ role: "user", parts: [{ text: "Hello world" }] }] },
				};
			}
			if (mode === "openai-responses") {
				return {
					url: `${effectiveBaseUrl}/responses`,
					body: { model: modelId, input: "Hello world" },
				};
			}
			return {
				url: `${effectiveBaseUrl}/chat/completions`,
				body: { model: modelId, messages: [{ role: "user", content: "Hello world" }], stream: false },
			};
		};

		const testOne = async (key: string): Promise<{ ok: boolean; error?: string }> => {
			try {
				const { url, body } = buildRequest();
				const requestHeaders = CommonApi.prepareHeaders(key, mode, headers, userAgent);
				// Gemini streams by default; force a JSON response for the test probe.
				if (mode === "gemini") {
					requestHeaders["Accept"] = "application/json";
				}
				const res = await fetch(url, {
					...networkInit,
					method: "POST",
					headers: requestHeaders,
					body: JSON.stringify(body),
				});
				if (!res.ok) {
					let text = "";
					try {
						text = await res.text();
					} catch {
						/* ignore body read errors */
					}
					return { ok: false, error: `[${res.status}] ${res.statusText}${text ? ` ${text.slice(0, 200)}` : ""}` };
				}
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		};

		const results = await Promise.all(keys.map((key) => testOne(key)));
		this.webview.postMessage({ type: "modelKeysTested", modelId, results });
	}

	private async refreshModelsFromApi(baseUrl: string, apiKey: string, proxyUrl?: string, userAgent?: string) {		try {
			const normalizedBaseUrl = baseUrl.trim();
			const normalizedApiKey = apiKey.trim();
			const normalizedProxyUrl = (proxyUrl || "").trim();
			const normalizedUserAgent = (userAgent || "").trim();
			const config = vscode.workspace.getConfiguration();
			const effectiveBaseUrl = normalizedBaseUrl;
			const effectiveApiKey = normalizedApiKey;
			const effectiveProxyUrl = resolveProxyUrl(normalizedProxyUrl, config.get<string>("customcopilot.proxyUrl", "").trim());
			const effectiveUserAgent =
				normalizedUserAgent ||
				config.get<string>(
					"customcopilot.userAgent",
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
				).trim();

			// If no API key was passed — try per-provider refresh instead
			if (!effectiveApiKey) {
				await this.refreshModelsFromAllProviders(effectiveProxyUrl, effectiveUserAgent);
				return;
			}

			if (!effectiveBaseUrl) {
				vscode.window.showErrorMessage("Base URL is not set. Please configure it first.");
				return;
			}

			const { models: fetchedModels } = await fetchModels(effectiveBaseUrl, effectiveApiKey, undefined, undefined, {
				proxyUrl: effectiveProxyUrl,
				userAgent: effectiveUserAgent,
			});
			if (fetchedModels.length === 0) {
				vscode.window.showWarningMessage("No models returned from the API endpoint.");
				return;
			}

			// Save fetched models to VS Code configuration
			await config.update("customcopilot.models", fetchedModels, vscode.ConfigurationTarget.Global);

			vscode.window.showInformationMessage(
				`Successfully refreshed ${fetchedModels.length} models from API endpoint.`
			);

			// Refresh the frontend
			await this.sendInit();
		} catch (err) {
			console.error("[customcopilot] refreshModelsFromApi failed", err);
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Failed to refresh models: ${errorMessage}`);
		}
	}

	/**
	 * Refresh models by fetching from each configured provider that has an API key.
	 * Used as fallback when no API key is passed directly.
	 */
	private async refreshModelsFromAllProviders(globalProxyUrl?: string, globalUserAgent?: string) {
		const config = vscode.workspace.getConfiguration();
		const currentModels = normalizeUserModels(config.get<unknown>("customcopilot.models", []));
		const providers = Array.from(new Set(currentModels.map((m) => m.owned_by).filter(Boolean)));

		if (providers.length === 0) {
			vscode.window.showErrorMessage(
				"No API Key configured. Add providers with API keys first."
			);
			return;
		}

		const allFetched: HFModelItem[] = [];
		let anySuccess = false;

		for (const provider of providers) {
			const providerKey = await this.secrets.get(`customcopilot.apiKey.${provider.toLowerCase()}`);
			if (!providerKey) {
				console.warn(`[customcopilot] No API key for provider: ${provider}, skipping refresh`);
				continue;
			}

			const providerModels = currentModels.filter((m) => m.owned_by === provider);
			const firstModel = providerModels[0];
			const providerBaseUrl = firstModel?.baseUrl || "";
			const providerProxyUrl = firstModel?.proxyUrl || globalProxyUrl;
			const providerUserAgent = firstModel?.userAgent || globalUserAgent;
			const providerApiMode = firstModel?.apiMode;

			if (!providerBaseUrl || !providerBaseUrl.startsWith("http")) {
				console.warn(`[customcopilot] No valid base URL for provider: ${provider}, skipping refresh`);
				continue;
			}

			try {
				const { models: fetched } = await fetchModels(providerBaseUrl, providerKey, providerApiMode, undefined, {
					proxyUrl: providerProxyUrl,
					userAgent: providerUserAgent,
				});
				// Tag models with their provider
				allFetched.push(...fetched.map((m) => ({ ...m, owned_by: m.owned_by || provider })));
				anySuccess = true;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[customcopilot] Failed to refresh models for provider ${provider}: ${msg}`);
				vscode.window.showWarningMessage(`Provider ${provider}: ${msg}`);
			}
		}

		if (!anySuccess || allFetched.length === 0) {
			vscode.window.showWarningMessage(
				"No models returned from any provider endpoint. Check your API keys and base URLs."
			);
			return;
		}

		await config.update("customcopilot.models", allFetched, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Successfully refreshed ${allFetched.length} models from ${providers.length} provider(s).`
		);
		await this.sendInit();
	}

	private async saveGlobalConfig(
		_rawBaseUrl: string,
		rawProxyUrl: string,
		rawUserAgent: string,
		delay: number,
		readFileLines: number,
		retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] },
		commitModel: string,
		commitLanguage: string
	) {
		const proxyUrl = rawProxyUrl.trim();
		const userAgent = rawUserAgent.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("customcopilot.proxyUrl", proxyUrl, vscode.ConfigurationTarget.Global);
		await config.update("customcopilot.userAgent", userAgent, vscode.ConfigurationTarget.Global);
		await config.update("customcopilot.delay", delay, vscode.ConfigurationTarget.Global);
		await config.update("customcopilot.readFileLines", readFileLines, vscode.ConfigurationTarget.Global);
		await config.update("customcopilot.retry", retry, vscode.ConfigurationTarget.Global);
		await config.update("customcopilot.commitLanguage", commitLanguage, vscode.ConfigurationTarget.Global);

		// Update models to set useForCommitGeneration based on selected commitModel
		if (commitModel) {
			const models = config.get<HFModelItem[]>("customcopilot.models", []);
			const updatedModels = models.map((model) => {
				const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
				if (fullModelId === commitModel) {
					return { ...model, useForCommitGeneration: true };
				} else {
					// Create a new object without the useForCommitGeneration property
					const updatedModel = { ...model };
					delete updatedModel.useForCommitGeneration;
					return updatedModel;
				}
			});
			await config.update("customcopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		}

		vscode.window.showInformationMessage(
			"Base URL, Proxy, User-Agent, Delay, Retry and API Key have been saved to global settings."
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async getHtml(webview: vscode.Webview) {
		const nonce = this.getNonce();
		const assetsRoot = vscode.Uri.joinPath(this.extensionUri, "assets", "configure");
		const templatePath = vscode.Uri.joinPath(assetsRoot, "configure.html");
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configure.css"));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, "configure.js"));
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} https:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src ${webview.cspSource} 'nonce-${nonce}'`,
		].join("; ");

		const raw = await vscode.workspace.fs.readFile(templatePath);
		let html = new TextDecoder("utf-8").decode(raw);
		html = html
			.replaceAll("%CSP_SOURCE%", csp)
			.replaceAll("%NONCE%", nonce)
			.replace("%CSS_URI%", cssUri.toString())
			.replace("%SCRIPT_URI%", jsUri.toString());
		return html;
	}

	private getNonce() {
		return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
	}

	private async addProvider(
		provider: string,
		baseUrl?: string,
		apiKey?: string,
		apiMode?: string,
		headers?: Record<string, string>,
		proxyUrl?: string,
		userAgent?: string,
		delay?: number
	) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Save API key for the provider
		if (apiKey) {
			await this.secrets.store(`customcopilot.apiKey.${normalizedProvider}`, apiKey);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`customcopilot.apiKey.${trimmedProvider}`);
			}
		}

		// Save provider configuration to the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

		// If the provider doesn't have models yet, add a default model
		const hasProviderModels = models.some((model) => model.owned_by === trimmedProvider);
		if (!hasProviderModels) {
			const defaultModel: HFModelItem = {
				id: `__provider__${trimmedProvider}`,
				owned_by: trimmedProvider,
				baseUrl: baseUrl,
				proxyUrl: proxyUrl,
				userAgent: userAgent,
				apiMode: (apiMode as HFApiMode) || "openai",
				headers: headers,
				delay: delay,
			};
			models.push(defaultModel);
		}

		await config.update("customcopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been added.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async updateProvider(
		provider: string,
		baseUrl?: string,
		apiKey?: string,
		apiMode?: string,
		headers?: Record<string, string>,
		proxyUrl?: string,
		userAgent?: string,
		delay?: number
	) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Update provider API key
		if (apiKey) {
			await this.secrets.store(`customcopilot.apiKey.${normalizedProvider}`, apiKey);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`customcopilot.apiKey.${trimmedProvider}`);
			}
		} else {
			await this.secrets.delete(`customcopilot.apiKey.${normalizedProvider}`);
			if (trimmedProvider !== normalizedProvider) {
				await this.secrets.delete(`customcopilot.apiKey.${trimmedProvider}`);
			}
		}

		// Update the provider's configuration in the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

		const updatedModels = models.map((model) => {
			if (model.owned_by === trimmedProvider) {
				// Create a new object with updated properties
				const updatedModel = { ...model };
				updatedModel.baseUrl = baseUrl || model.baseUrl;
				updatedModel.apiMode = (apiMode as HFApiMode) || model.apiMode;
				updatedModel.proxyUrl = proxyUrl !== undefined ? proxyUrl : model.proxyUrl;
				updatedModel.userAgent = userAgent !== undefined ? userAgent : model.userAgent;
				if (headers !== undefined) {
					updatedModel.headers = headers;
				}
				if (delay !== undefined) {
					updatedModel.delay = delay;
				}
				return updatedModel;
			}
			return model;
		});

		await config.update("customcopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} has been updated.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async deleteProvider(provider: string) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider) {
			vscode.window.showErrorMessage("Provider ID is required.");
			return;
		}
		const normalizedProvider = trimmedProvider.toLowerCase();
		// Delete provider API key
		await this.secrets.delete(`customcopilot.apiKey.${normalizedProvider}`);
		if (trimmedProvider !== normalizedProvider) {
			await this.secrets.delete(`customcopilot.apiKey.${trimmedProvider}`);
		}

		// Remove all models of this provider from the model list
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));
		const filteredModels = models.filter((model) => model.owned_by !== trimmedProvider);

		await config.update("customcopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Provider ${provider} and all its models have been deleted.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private getProviderDefaultSource(models: HFModelItem[], provider?: string): HFModelItem | undefined {
		if (!provider) {
			return undefined;
		}
		const providerModels = models.filter((m) => m.owned_by === provider);
		return providerModels.find((m) => m.id.startsWith("__provider__")) || providerModels[0];
	}

	private fillModelDefaults(model: HFModelItem, source: HFModelItem | undefined): HFModelItem {
		if (!source) {
			return model;
		}
		const merged: HFModelItem = { ...model };
		if (!merged.baseUrl) {
			merged.baseUrl = source.baseUrl;
		}
		if (!merged.apiMode) {
			merged.apiMode = source.apiMode;
		}
		if (merged.proxyUrl === undefined) {
			merged.proxyUrl = source.proxyUrl;
		}
		if (merged.userAgent === undefined) {
			merged.userAgent = source.userAgent;
		}
		if (merged.headers === undefined) {
			merged.headers = source.headers;
		}
		return merged;
	}

	private async addModel(model: HFModelItem) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("customcopilot.models", []);

		// Check if model with same id and configId already exists
		const existingIndex = models.findIndex(
			(m) =>
				m.id === model.id && ((model.configId && m.configId === model.configId) || (!model.configId && !m.configId))
		);
		if (existingIndex !== -1) {
			vscode.window.showErrorMessage(`Model ${model.id}${model.configId ? "::" + model.configId : ""} already exists.`);
			return;
		}

		// The model form does not carry provider-level settings (baseUrl, apiMode,
		// proxyUrl, ...). Inherit them from the provider's existing models so the
		// saved model always has a usable baseUrl.
		const modelToSave = this.fillModelDefaults(model, this.getProviderDefaultSource(models, model.owned_by));

		models.push(modelToSave);
		await config.update("customcopilot.models", models, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Model ${model.id}${model.configId ? "::" + model.configId : ""} has been added.`
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async updateModel(model: HFModelItem, originalModelId?: string, originalConfigId?: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("customcopilot.models", []);

		// Find the model to update based on original id and configId
		const updatedModels = models.map((m) => {
			// Check if this is the model we want to update
			// If originalConfigId is undefined (meaning it was originally null/undefined),
			// then look for a model with no configId
			const isTargetModel =
				m.id === originalModelId &&
				((originalConfigId && m.configId === originalConfigId) || (!originalConfigId && !m.configId));

			if (isTargetModel) {
				// Update with new values, but keep provider-level settings
				// (baseUrl, apiMode, ...) that the model form does not carry by
				// inheriting them from the original model, then provider defaults.
				let merged = this.fillModelDefaults(model, m);
				merged = this.fillModelDefaults(merged, this.getProviderDefaultSource(models, model.owned_by));
				return merged;
			}
			return m;
		});

		await config.update("customcopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			`Model ${model.id}${model.configId ? "::" + model.configId : ""} has been updated.`
		);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async deleteModel(modelId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("customcopilot.models", []);
		const parsedModelId = parseModelId(modelId);

		const filteredModels = models.filter((model) => {
			return !(
				model.id === parsedModelId.baseId &&
				((parsedModelId.configId && model.configId === parsedModelId.configId) ||
					(!parsedModelId.configId && !model.configId))
			);
		});

		await config.update("customcopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Model ${modelId} has been deleted.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async deleteModels(modelIds: string[]) {
		const config = vscode.workspace.getConfiguration();
		const models = config.get<HFModelItem[]>("customcopilot.models", []);
		const parsedIds = modelIds.map(id => parseModelId(id));

		const filteredModels = models.filter((model) => {
			return !parsedIds.some(parsed =>
				model.id === parsed.baseId &&
				((parsed.configId && model.configId === parsed.configId) ||
					(!parsed.configId && !model.configId))
			);
		});

		await config.update("customcopilot.models", filteredModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(`Deleted ${modelIds.length} models.`);
		// Send refresh signal to frontend
		await this.sendInit();
	}

	private async importModels(models: HFModelItem[], provider: string) {
		const trimmedProvider = provider.trim();
		if (!trimmedProvider || !Array.isArray(models) || models.length === 0) {
			return;
		}

		try {
			const config = vscode.workspace.getConfiguration();
			const existing = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

			// Retrieve provider settings from placeholder entry
			const placeholder = existing.find(
				(m) => m.owned_by === trimmedProvider && m.id.startsWith("__provider__")
			);
			const providerBase = {
				owned_by:  trimmedProvider,
				baseUrl:   placeholder?.baseUrl,
				proxyUrl:  placeholder?.proxyUrl,
				userAgent: placeholder?.userAgent,
				apiMode:   placeholder?.apiMode,
				headers:   placeholder?.headers,
				delay:     placeholder?.delay,
			};

			const existingIds = new Set(
				existing
					.filter((m) => m.owned_by === trimmedProvider && !m.id.startsWith("__provider__"))
					.map((m) => (m.configId ? `${m.id}::${m.configId}` : m.id))
			);

			let added = 0;
			for (const m of models) {
				const fid = m.configId ? `${m.id}::${m.configId}` : m.id;
				if (existingIds.has(fid)) { continue; }
				existing.push({ ...providerBase, ...m, owned_by: trimmedProvider });
				existingIds.add(fid);
				added++;
			}

			if (added === 0) {
				vscode.window.showInformationMessage("All selected models are already added.");
				await this.sendInit();
				return;
			}

			await config.update("customcopilot.models", existing, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Imported ${added} model(s) to provider ${trimmedProvider}.`);
			await this.sendInit();
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error(`[customcopilot] importModels failed: ${errMsg}`, err);
			vscode.window.showErrorMessage(`Failed to import models: ${errMsg}`);
		}
	}

	private async saveCommitSettings(commitModel: string, commitLanguage: string) {
		const config = vscode.workspace.getConfiguration();
		await config.update("customcopilot.commitLanguage", commitLanguage, vscode.ConfigurationTarget.Global);

		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));
		const updatedModels = models.map((m) => {
			const fid = m.configId ? `${m.id}::${m.configId}` : m.id;
			if (fid === commitModel) {
				return { ...m, useForCommitGeneration: true };
			}
			const updated = { ...m };
			delete updated.useForCommitGeneration;
			return updated;
		});
		await config.update("customcopilot.models", updatedModels, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage("Commit settings saved.");
		await this.sendInit();
	}

	private async setAnonymousAccess(enabled: boolean) {
		const config = vscode.workspace.getConfiguration();
		await config.update("chat.allowAnonymousAccess", enabled, vscode.ConfigurationTarget.Global);
		const choice = await vscode.window.showInformationMessage(
			enabled
				? "Anonymous Copilot Chat access enabled. Reload the window to use Chat without a GitHub account."
				: "Anonymous Copilot Chat access disabled. Reload the window to apply.",
			"Reload Window"
		);
		if (choice === "Reload Window") {
			await vscode.commands.executeCommand("workbench.action.reloadWindow");
		}
		await this.sendInit();
	}

	private async setRestoreChatSessions(enabled: boolean) {
		const config = vscode.workspace.getConfiguration();
		// VS Code only restores the last chat panel session after a full restart when
		// `chat.restoreLastPanelSession` is true; otherwise the persisted session reference
		// is cleared on a fresh start (see ChatViewPane). The session files themselves are
		// always written to disk, so enabling this makes chats survive restarts even when
		// signed out of GitHub (anonymous access).
		await config.update("chat.restoreLastPanelSession", enabled, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			enabled
				? "Chat sessions will now be restored after restarting VS Code."
				: "Chat sessions will no longer be restored after restart."
		);
		await this.sendInit();
	}

	private async setTelemetryDisabled(disabled: boolean) {
		const config = vscode.workspace.getConfiguration();
		// VS Code core sends the selected model id in the "interactiveSessionProviderInvoked"
		// telemetry event, which would reveal which third-party providers/models are in use.
		// Turning telemetry off (or back to "all") is the only lever that controls this.
		await config.update("telemetry.telemetryLevel", disabled ? "off" : "all", vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			disabled
				? "VS Code telemetry disabled. Your model/provider usage is no longer reported."
				: "VS Code telemetry re-enabled (level: all)."
		);
		await this.sendInit();
	}

	private async setChatRetries(value: number) {
		const config = vscode.workspace.getConfiguration();
		const normalized = Number.isFinite(value) ? Math.max(-1, Math.trunc(value)) : 0;
		await config.update("customcopilot.chatRetries", normalized, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			normalized === 0
				? "Automatic chat retries disabled."
				: normalized < 0
					? "Automatic chat retries set to infinite."
					: `Automatic chat retries set to ${normalized}.`
		);
		await this.sendInit();
	}

	private async setChatRetryInterval(value: number) {
		const config = vscode.workspace.getConfiguration();
		const normalized = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 1000;
		await config.update("customcopilot.chatRetryInterval", normalized, vscode.ConfigurationTarget.Global);
		await this.sendInit();
	}

	private async setChatRetryJitter(value: number) {
		const config = vscode.workspace.getConfiguration();
		const normalized = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
		await config.update("customcopilot.chatRetryJitter", normalized, vscode.ConfigurationTarget.Global);
		await this.sendInit();
	}

	private resolveModelSelector(modelFullId?: string): { id: string; vendor: string } | undefined {
		if (!modelFullId) {
			return undefined;
		}
		const config = vscode.workspace.getConfiguration();
		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));
		const match = models.find((m) => (m.configId ? `${m.id}::${m.configId}` : m.id) === modelFullId);
		const apiMode = (match?.apiMode ?? "openai") as HFApiMode;
		const vendorByMode: Record<string, string> = {
			"openai": "copilotcustommodelsendpoint",
			"openai-responses": "copilotcustommodelsendpoint-responses",
			"anthropic": "copilotcustommodelsendpoint-anthropic",
			"gemini": "copilotcustommodelsendpoint-gemini",
			"ollama": "copilotcustommodelsendpoint-ollama",
		};
		return { id: modelFullId, vendor: vendorByMode[apiMode] ?? "copilotcustommodelsendpoint" };
	}

	private normalizeChatMode(mode?: string): string {
		const value = (mode ?? "agent").toLowerCase();
		if (value === "ask" || value === "edit" || value === "agent") {
			return value;
		}
		return "agent";
	}

	private async prefillChat(prompt: string, mode?: string, modelFullId?: string) {
		const text = (prompt ?? "").trim();
		if (!text) {
			vscode.window.showWarningMessage("Cannot open an empty prompt.");
			return;
		}
		const selector = this.resolveModelSelector(modelFullId);
		const opts: Record<string, unknown> = {
			query: text,
			mode: this.normalizeChatMode(mode),
			isPartialQuery: true,
		};
		if (selector) {
			opts.modelSelector = selector;
		}
		try {
			await vscode.commands.executeCommand("workbench.action.chat.open", opts);
		} catch (err) {
			console.error("[customcopilot] prefillChat failed", err);
			vscode.window.showErrorMessage(
				`Failed to open chat: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	private async launchChats(
		prompts: string[],
		mode: string | undefined,
		modelFullId: string | undefined,
		strategy: "sequential" | "parallel",
		delayMs: number
	) {
		const cleanPrompts = (Array.isArray(prompts) ? prompts : [])
			.map((p) => (typeof p === "string" ? p.trim() : ""))
			.filter((p) => p.length > 0);

		if (cleanPrompts.length === 0) {
			vscode.window.showWarningMessage("No prompts to launch. Add a template and replacements first.");
			return;
		}

		const confirm = await vscode.window.showWarningMessage(
			`Launch ${cleanPrompts.length} chat session(s) ${
				strategy === "parallel" ? "in parallel (best-effort)" : "sequentially"
			}?`,
			{ modal: true },
			"Launch"
		);
		if (confirm !== "Launch") {
			return;
		}

		const chatMode = this.normalizeChatMode(mode);
		const selector = this.resolveModelSelector(modelFullId);
		const safeDelay = Math.max(0, Math.min(delayMs, 60000));

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Launching Copilot chats",
				cancellable: true,
			},
			async (progress, token) => {
				for (let i = 0; i < cleanPrompts.length; i++) {
					if (token.isCancellationRequested) {
						break;
					}
					progress.report({
						message: `${i + 1}/${cleanPrompts.length}`,
						increment: 100 / cleanPrompts.length,
					});

					// Start each prompt in its own fresh panel session so they are saved as
					// separate chats. The first one reuses the current panel.
					if (i > 0) {
						try {
							await vscode.commands.executeCommand("workbench.action.chat.newChat");
						} catch (err) {
							console.error("[customcopilot] newChat failed", err);
						}
					}

					const opts: Record<string, unknown> = {
						query: cleanPrompts[i],
						mode: chatMode,
					};
					if (selector) {
						opts.modelSelector = selector;
					}
					// Sequential waits for each response before moving on; parallel fires the
					// request and continues so sessions run concurrently (best-effort: VS Code
					// exposes no API for guaranteed parallel auto-submit).
					if (strategy === "sequential") {
						opts.blockOnResponse = true;
					}

					// Snapshot the request counter before opening so we can detect when VS Code
					// actually dispatches this prompt to our provider (see below).
					const startCountBefore = getChatRequestStartCount();

					try {
						await vscode.commands.executeCommand("workbench.action.chat.open", opts);
					} catch (err) {
						console.error("[customcopilot] chat.open failed", err);
						vscode.window.showErrorMessage(
							`Failed to launch chat ${i + 1}: ${err instanceof Error ? err.message : String(err)}`
						);
						break;
					}

					// In parallel mode `chat.open` returns before the prompt has actually been
					// submitted (input acceptance is async). If we created the next session via
					// `newChat` right away, VS Code would dispose this still-empty session and
					// DELETE it (empty sessions without a custom title are not persisted), so
					// some launched chats would silently vanish from history. Wait until our
					// provider is invoked — that only happens once the request is registered on
					// the session model — before continuing. A timeout guards against models
					// that are not handled by this extension.
					if (strategy === "parallel" && i < cleanPrompts.length - 1) {
						await waitForChatRequestStart(startCountBefore, 20000, token);
						if (safeDelay > 0 && !token.isCancellationRequested) {
							await new Promise((resolve) => setTimeout(resolve, safeDelay));
						}
					}
				}
			}
		);

		vscode.window.showInformationMessage(`Launched ${cleanPrompts.length} chat session(s).`);
	}

	private async exportConfig() {
		try {
			const config = vscode.workspace.getConfiguration();
			const proxyUrl = config.get<string>("customcopilot.proxyUrl", "");
			const delay = config.get<number>("customcopilot.delay", 0);
			const retry = config.get<{
				enabled?: boolean;
				max_attempts?: number;
				interval_ms?: number;
				status_codes?: number[];
			}>("customcopilot.retry", {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
			});
			const commitLanguage = config.get<string>("customcopilot.commitLanguage", "English");
			const readFileLines = config.get<number>("customcopilot.readFileLines", 0);
			const models = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

			const foundModel = models.find((model) => model.useForCommitGeneration === true);
			const commitModel = foundModel ? `${foundModel.id}${foundModel.configId ? "::" + foundModel.configId : ""}` : "";

			const providerKeys: Record<string, string> = {};
			const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
			for (const provider of providers) {
				const normalized = provider.toLowerCase();
				const key = await this.secrets.get(`customcopilot.apiKey.${normalized}`);
				if (key) {
					providerKeys[provider] = key;
				}
			}

			const exportData: ExportConfig = {
				version: VersionManager.getVersion(),
				exportDate: new Date().toISOString(),
				proxyUrl,
				delay,
				retry,
				commitLanguage,
				commitModel,
				models,
				readFileLines,
				providerKeys,
			};

			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(`customcopilot-config-${new Date().toISOString().split("T")[0]}.json`),
				filters: { "JSON Files": ["json"] },
				title: "Export customcopilot Configuration",
			});

			if (!uri) {
				vscode.window.showInformationMessage("Export configuration cancelled.");
				return;
			}

			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(uri, encoder.encode(JSON.stringify(exportData, null, 2)));

			vscode.window.showInformationMessage(`Configuration exported to ${uri.fsPath}`);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			vscode.window.showErrorMessage(`Failed to export configuration: ${errorMessage}`);
		}
	}

	private async importConfig() {
		try {
			const uri = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: { "JSON Files": ["json"] },
				title: "Import customcopilot Configuration",
			});

			if (!uri || uri.length === 0) {
				vscode.window.showInformationMessage("Import configuration cancelled.");
				return;
			}

			const content = await vscode.workspace.fs.readFile(uri[0]);
			const decoder = new TextDecoder();
			const jsonContent = decoder.decode(content);
			const importData = JSON.parse(jsonContent) as ExportConfig;

			if (!Array.isArray(importData.models)) {
				throw new Error("Invalid configuration file: models must be an array");
			}

			const config = vscode.workspace.getConfiguration();

			await config.update("customcopilot.proxyUrl", importData.proxyUrl || "", vscode.ConfigurationTarget.Global);
			await config.update("customcopilot.delay", importData.delay, vscode.ConfigurationTarget.Global);
			await config.update("customcopilot.retry", importData.retry, vscode.ConfigurationTarget.Global);
			await config.update("customcopilot.readFileLines", importData.readFileLines, vscode.ConfigurationTarget.Global);
			await config.update("customcopilot.commitLanguage", importData.commitLanguage, vscode.ConfigurationTarget.Global);

			await config.update("customcopilot.models", importData.models, vscode.ConfigurationTarget.Global);

			for (const [provider, key] of Object.entries(importData.providerKeys)) {
				const normalized = provider.toLowerCase();
				if (key) {
					await this.secrets.store(`customcopilot.apiKey.${normalized}`, key);
				} else {
					await this.secrets.delete(`customcopilot.apiKey.${normalized}`);
				}
			}

			vscode.window.showInformationMessage("Configuration imported successfully.");
			await this.sendInit();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			vscode.window.showErrorMessage(`Failed to import configuration: ${errorMessage}`);
		}
	}
}

export class SettingsPanel {
	public static currentPanel: SettingsPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly controller: ConfigViewController;

	public static openPanel(extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (SettingsPanel.currentPanel) {
			SettingsPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"customcopilot.config",
			"Copilot Custom Models Endpoint Configuration",
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out"), vscode.Uri.joinPath(extensionUri, "assets")],
			}
		);

		SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, secrets);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		this.panel = panel;
		this.controller = new ConfigViewController(panel.webview, extensionUri, secrets);
		this.panel.onDidDispose(() => this.dispose());
	}

	public dispose() {
		SettingsPanel.currentPanel = undefined;
		this.panel.dispose();
		this.controller.dispose();
	}
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "customcopilot.settingsView";
	private controller?: ConfigViewController;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly secrets: vscode.SecretStorage
	) {}

	public async resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "out"),
				vscode.Uri.joinPath(this.extensionUri, "assets")
			]
		};

		this.controller = new ConfigViewController(webviewView.webview, this.extensionUri, this.secrets);

		webviewView.onDidDispose(() => {
			this.controller?.dispose();
			this.controller = undefined;
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.controller?.sendInit();
			}
		});
	}
}
