import * as vscode from "vscode";
import type { HFApiMode, HFModelItem } from "../types";
import { normalizeUserModels, parseModelId, resolveProxyUrl } from "../utils";
import { fetchModels } from "../provideModel";
import { VersionManager } from "../versionManager";

interface InitPayload {
	baseUrl: string;
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
	telemetryDisabled: boolean;
}

interface ExportConfig {
	version: string;
	exportDate: string;
	baseUrl: string;
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
	| { type: "setTelemetryDisabled"; disabled: boolean }
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
					const { models } = await fetchModels(message.baseUrl, message.apiKey, message.apiMode, message.headers, {
						proxyUrl: message.proxyUrl,
						userAgent: message.userAgent,
					});
					this.webview.postMessage({ type: "modelsFetched", models });
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
			case "setTelemetryDisabled":
				await this.setTelemetryDisabled(message.disabled);
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
		const baseUrl = config.get<string>("customcopilot.baseUrl", "https://api.openai.com/v1");
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
		const telemetryDisabled = config.get<string>("telemetry.telemetryLevel", "all") === "off";
		const payload: InitPayload = {
			baseUrl,
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
			telemetryDisabled,
		};
		this.webview.postMessage({ type: "init", payload });
	}

	private async refreshModelsFromApi(baseUrl: string, apiKey: string, proxyUrl?: string, userAgent?: string) {
		try {
			const normalizedBaseUrl = baseUrl.trim();
			const normalizedApiKey = apiKey.trim();
			const normalizedProxyUrl = (proxyUrl || "").trim();
			const normalizedUserAgent = (userAgent || "").trim();
			const config = vscode.workspace.getConfiguration();
			const effectiveBaseUrl = normalizedBaseUrl || config.get<string>("customcopilot.baseUrl", "").trim();
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
			const providerBaseUrl = firstModel?.baseUrl || config.get<string>("customcopilot.baseUrl", "").trim();
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
		rawBaseUrl: string,
		rawProxyUrl: string,
		rawUserAgent: string,
		delay: number,
		readFileLines: number,
		retry: { enabled?: boolean; max_attempts?: number; interval_ms?: number; status_codes?: number[] },
		commitModel: string,
		commitLanguage: string
	) {
		const baseUrl = rawBaseUrl.trim();
		const proxyUrl = rawProxyUrl.trim();
		const userAgent = rawUserAgent.trim();
		const config = vscode.workspace.getConfiguration();
		await config.update("customcopilot.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
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

		models.push(model);
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
				// Update with new values
				return model;
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

	private async exportConfig() {
		try {
			const config = vscode.workspace.getConfiguration();
			const baseUrl = config.get<string>("customcopilot.baseUrl", "https://api.openai.com/v1");
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
				baseUrl,
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

			await config.update("customcopilot.baseUrl", importData.baseUrl, vscode.ConfigurationTarget.Global);
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
