/**
 * Configuration export / import: writes/reads a JSON file with global
 * settings, all models and provider key pools. Extracted from
 * configView.ts — the controller delegates here.
 */

import * as vscode from "vscode";
import type { CustomModelItem } from "../types";
import { normalizeUserModels } from "../utils";
import { VersionManager } from "../versionManager";

export interface ExportConfig {
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
	models: CustomModelItem[];
	providerKeys: Record<string, string>;
	providerKeySources?: Record<string, string>;
	readFileLines: number;
}

export async function exportConfig(secrets: vscode.SecretStorage): Promise<void> {
	try {
		// dedent one tab
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
		const providerKeySources: Record<string, string> = {};
		const providers = Array.from(new Set(models.map((m) => m.owned_by).filter(Boolean)));
		for (const provider of providers) {
			const normalized = provider.toLowerCase();
			const key = await secrets.get(`customcopilot.apiKey.${normalized}`);
			if (key) {
				providerKeys[provider] = key;
			}
			const source = await secrets.get(`customcopilot.apiKeySource.${normalized}`);
			if (source) {
				providerKeySources[provider] = source;
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
			providerKeySources,
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
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		vscode.window.showErrorMessage(`Failed to export configuration: ${errorMessage}`);
	}
}

export async function importConfig(secrets: vscode.SecretStorage, onDone: () => Promise<void>): Promise<void> {
	try {
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
				await secrets.store(`customcopilot.apiKey.${normalized}`, key);
			} else {
				await secrets.delete(`customcopilot.apiKey.${normalized}`);
			}
		}

		if (importData.providerKeySources) {
			for (const [provider, source] of Object.entries(importData.providerKeySources)) {
				const trimmedSource = (source ?? "").trim();
				const normalized = provider.toLowerCase();
				if (trimmedSource) {
					await secrets.store(`customcopilot.apiKeySource.${normalized}`, trimmedSource);
				} else {
					await secrets.delete(`customcopilot.apiKeySource.${normalized}`);
				}
			}
		}

		vscode.window.showInformationMessage("Configuration imported successfully.");
		await onDone();
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		vscode.window.showErrorMessage(`Failed to import configuration: ${errorMessage}`);
	}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		vscode.window.showErrorMessage(`Failed to import configuration: ${errorMessage}`);
	}
}
