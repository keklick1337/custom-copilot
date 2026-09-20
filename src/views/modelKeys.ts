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

/**
 * Remove the model identified by a webview model key from the models array.
 * When a #index suffix is present, only that specific duplicate is removed.
 * Without it, the first matching model (by id+configId) is removed.
 */
export function filterModelsByIdentifier(models: CustomModelItem[], key: string): CustomModelItem[] {
	const parsed = parseWebviewModelKey(key);
	// Build the list of matching models in array order so the index maps
	// correctly to the #index suffix used in the webview.
	const matchingIndices: number[] = [];
	for (let i = 0; i < models.length; i++) {
		const m = models[i];
		if (
			m.id === parsed.baseId &&
			((parsed.configId && m.configId === parsed.configId) || (!parsed.configId && !m.configId))
		) {
			matchingIndices.push(i);
		}
	}
	if (parsed.index >= 0 && parsed.index < matchingIndices.length) {
		// Remove the specific duplicate at the given index
		const targetIdx = matchingIndices[parsed.index];
		return models.filter((_, i) => i !== targetIdx);
	}
	// No #index: remove the first matching model
	const targetIdx = matchingIndices[0];
	if (targetIdx === undefined) {
		return models;
	}
	return models.filter((_, i) => i !== targetIdx);
}
