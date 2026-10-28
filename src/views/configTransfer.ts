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
		// Only entries with an id are exportable — import rejects id-less
		// (half-typed) entries, so exporting them would yield an unimportable file.
		const models = normalizeUserModels(config.get<unknown>("customcopilot.models", [])).filter(
			(m) => typeof m.id === "string" && m.id.trim() !== ""
		);

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
}

type RetryConfig = ExportConfig["retry"];

/** Validated, ready-to-apply subset of an import file. */
interface ValidatedImport {
	proxyUrl?: string;
	delay?: number;
	retry?: RetryConfig;
	readFileLines?: number;
	commitLanguage?: string;
	models: CustomModelItem[];
	providerKeys: Record<string, string>;
	providerKeySources: Record<string, string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateStringMap(value: unknown, field: string): Record<string, string> {
	if (value === undefined || value === null) {
		return {};
	}
	if (!isPlainObject(value)) {
		throw new Error(`Invalid configuration file: ${field} must be an object`);
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (!k.trim()) {
			throw new Error(`Invalid configuration file: ${field} contains an empty provider id`);
		}
		if (v !== null && v !== undefined && typeof v !== "string") {
			throw new Error(`Invalid configuration file: ${field}.${k} must be a string`);
		}
		out[k] = typeof v === "string" ? v : "";
	}
	return out;
}

function validateOptionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid configuration file: ${field} must be a non-negative number`);
	}
	return value;
}

function validateOptionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid configuration file: ${field} must be a string`);
	}
	return value;
}

/**
 * Validate the whole import file BEFORE anything is applied, so a malformed
 * file can never leave the configuration half-imported.
 */
function validateImport(raw: unknown): ValidatedImport {
	if (!isPlainObject(raw)) {
		throw new Error("Invalid configuration file: expected a JSON object");
	}
	if (!Array.isArray(raw.models)) {
		throw new Error("Invalid configuration file: models must be an array");
	}
	raw.models.forEach((m, i) => {
		if (!isPlainObject(m) || typeof m.id !== "string" || !m.id.trim()) {
			throw new Error(`Invalid configuration file: models[${i}] must be an object with a non-empty string id`);
		}
	});
	let retry: RetryConfig | undefined;
	if (raw.retry !== undefined && raw.retry !== null) {
		if (!isPlainObject(raw.retry)) {
			throw new Error("Invalid configuration file: retry must be an object");
		}
		const codes = raw.retry.status_codes;
		if (codes !== undefined && (!Array.isArray(codes) || codes.some((c) => typeof c !== "number"))) {
			throw new Error("Invalid configuration file: retry.status_codes must be an array of numbers");
		}
		if (raw.retry.enabled !== undefined && typeof raw.retry.enabled !== "boolean") {
			throw new Error("Invalid configuration file: retry.enabled must be a boolean");
		}
		validateOptionalNumber(raw.retry.max_attempts, "retry.max_attempts");
		validateOptionalNumber(raw.retry.interval_ms, "retry.interval_ms");
		retry = raw.retry as RetryConfig;
	}
	return {
		proxyUrl: validateOptionalString(raw.proxyUrl, "proxyUrl"),
		delay: validateOptionalNumber(raw.delay, "delay"),
		retry,
		readFileLines: validateOptionalNumber(raw.readFileLines, "readFileLines"),
		commitLanguage: validateOptionalString(raw.commitLanguage, "commitLanguage"),
		models: normalizeUserModels(raw.models),
		providerKeys: validateStringMap(raw.providerKeys, "providerKeys"),
		providerKeySources: validateStringMap(raw.providerKeySources, "providerKeySources"),
	};
}

export async function importConfig(secrets: vscode.SecretStorage, onDone: () => Promise<void>): Promise<void> {
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
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonContent);
		} catch (err) {
			throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
		// Validate everything up front; nothing is written unless the whole file is valid.
		const importData = validateImport(parsed);

		const config = vscode.workspace.getConfiguration();
		const target = vscode.ConfigurationTarget.Global;

		if (importData.proxyUrl !== undefined) {
			await config.update("customcopilot.proxyUrl", importData.proxyUrl, target);
		}
		if (importData.delay !== undefined) {
			await config.update("customcopilot.delay", importData.delay, target);
		}
		if (importData.retry !== undefined) {
			await config.update("customcopilot.retry", importData.retry, target);
		}
		if (importData.readFileLines !== undefined) {
			await config.update("customcopilot.readFileLines", importData.readFileLines, target);
		}
		if (importData.commitLanguage !== undefined) {
			await config.update("customcopilot.commitLanguage", importData.commitLanguage, target);
		}

		await config.update("customcopilot.models", importData.models, target);

		for (const [provider, key] of Object.entries(importData.providerKeys ?? {})) {
			const normalized = provider.toLowerCase();
			if (key.trim()) {
				await secrets.store(`customcopilot.apiKey.${normalized}`, key);
			} else {
				await secrets.delete(`customcopilot.apiKey.${normalized}`);
			}
		}

		for (const [provider, source] of Object.entries(importData.providerKeySources ?? {})) {
			const trimmedSource = source.trim();
			const normalized = provider.toLowerCase();
			if (trimmedSource) {
				await secrets.store(`customcopilot.apiKeySource.${normalized}`, trimmedSource);
			} else {
				await secrets.delete(`customcopilot.apiKeySource.${normalized}`);
			}
		}

		vscode.window.showInformationMessage("Configuration imported successfully.");
		await onDone();
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		vscode.window.showErrorMessage(`Failed to import configuration: ${errorMessage}`);
	}
}
