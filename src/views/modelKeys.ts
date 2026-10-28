import type { CustomModelItem } from "../types";

/**
 * Webview model-key utilities. The webview identifies models as
 * "baseId::configId#index" where #index disambiguates duplicates sharing the
 * same id+configId (index is the position among those duplicates, in array
 * order). Extracted from configView.ts so the matching logic has one home.
 */

export function parseWebviewModelKey(key: string): { baseId: string; configId: string | undefined; index: number } {
	const hashIdx = key.lastIndexOf("#");
	let index = -1;
	let idPart = key;
	if (hashIdx >= 0) {
		const suffix = key.slice(hashIdx + 1);
		if (/^\d+$/.test(suffix)) {
			index = parseInt(suffix, 10);
			idPart = key.slice(0, hashIdx);
		}
	}
	const sep = idPart.indexOf("::");
	if (sep >= 0) {
		return { baseId: idPart.slice(0, sep), configId: idPart.slice(sep + 2), index };
	}
	return { baseId: idPart, configId: undefined, index };
}

/** True when `m` matches the id+configId part of a parsed webview key. */
function matchesParsedKey(m: CustomModelItem, parsed: { baseId: string; configId: string | undefined }): boolean {
	return m.id === parsed.baseId && ((parsed.configId && m.configId === parsed.configId) || (!parsed.configId && !m.configId));
}

/**
 * Resolve a webview model key to an absolute index into `models`. With a #index
 * suffix the N-th duplicate (in array order) sharing id+configId is chosen;
 * without it, the first match. Returns -1 when nothing matches (including an
 * out-of-range #index).
 */
export function findIndexByWebviewKey(models: readonly CustomModelItem[], key: string): number {
	const parsed = parseWebviewModelKey(key);
	let dupCounter = 0;
	for (let i = 0; i < models.length; i++) {
		if (matchesParsedKey(models[i], parsed)) {
			if (parsed.index < 0 || dupCounter === parsed.index) {
				return i;
			}
			dupCounter++;
		}
	}
	return -1;
}

/**
 * Remove the model identified by a webview model key from the models array.
 * When a #index suffix is present, only that specific duplicate is removed.
 * Without it, the first matching model (by id+configId) is removed.
 */
export function filterModelsByIdentifier(models: CustomModelItem[], key: string): CustomModelItem[] {
	const targetIdx = findIndexByWebviewKey(models, key);
	if (targetIdx < 0) {
		return models;
	}
	return models.filter((_, i) => i !== targetIdx);
}

/**
 * Remove every model identified by the given webview keys. All keys are
 * resolved to absolute indices against the ORIGINAL array first; removing one
 * by one would shift #index positions and delete the wrong duplicates.
 */
export function filterModelsByIdentifiers(models: CustomModelItem[], keys: readonly string[]): CustomModelItem[] {
	const targets = new Set<number>();
	for (const key of keys) {
		const idx = findIndexByWebviewKey(models, key);
		if (idx >= 0) {
			targets.add(idx);
		}
	}
	return models.filter((_, i) => !targets.has(i));
}

/**
 * Build the model id registered with VS Code for `models[index]`, exactly as
 * prepareLanguageModelChatInformation (src/provideModel.ts) constructs it:
 * `${providerKey}:${idx}:${id}${configId ? "::" + configId : ""}` where
 * providerKey is the sanitised owned_by and idx is the position among the
 * vendor-scoped (same apiMode, non-placeholder) models sharing the same id.
 */
export function buildRegisteredModelId(models: readonly CustomModelItem[], index: number): string | undefined {
	const target = models[index];
	if (!target || target.id.startsWith("__provider__")) {
		return undefined;
	}
	const mode = target.apiMode ?? "openai";
	let idx = 0;
	for (let i = 0; i < index; i++) {
		const m = models[i];
		if (!m.id.startsWith("__provider__") && (m.apiMode ?? "openai") === mode && m.id === target.id) {
			idx++;
		}
	}
	const providerKey = (target.owned_by || "custom").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	const configPart = target.configId ? `::${target.configId}` : "";
	return `${providerKey}:${idx}:${target.id}${configPart}`;
}
