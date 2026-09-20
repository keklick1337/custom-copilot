import * as vscode from "vscode";
import { LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { tokenizerManager } from "./tokenizer/tokenizerManager";
import { getImageDimensions } from "./tokenizer/imageUtils";
import { createDataUrl } from "./utils";
import { estimateTokensRough } from "./roughTokens";

/*
 * Each message comes with 3 tokens per message due to special characters
 */
export const BaseTokensPerMessage = 3;
/*
 * Each name costs 1 token
 */
export const BaseTokensPerName = 1;

export async function countMessageTokens(
	text: string | LanguageModelChatRequestMessage,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
	if (typeof text === "string") {
		return textTokenLength(text);
	} else {
		// For complex messages, calculate tokens for each part separately
		let totalTokens = BaseTokensPerMessage + BaseTokensPerName;

		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				// Estimate tokens directly for plain text
				totalTokens += await textTokenLength(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				// Estimate tokens for image or data parts based on type
				if (part.mimeType.startsWith("image/")) {
					totalTokens += calculateImageTokenCost(createDataUrl(part));
				} else if (part.mimeType === "cache_control") {
					/* ignore */
				} else {
					// For other binary data, use a more conservative estimate
					totalTokens += calculateNonImageBinaryTokens(part.data.byteLength);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				// Tool call token calculation
				totalTokens += BaseTokensPerName;
				totalTokens += await textTokenLength(JSON.stringify(part.input));
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				// Tool result token calculation
				totalTokens += await textTokenLength(JSON.stringify(part.content));
			} else if (part instanceof vscode.LanguageModelThinkingPart) {
				// Thinking Token
				if (modelConfig.includeReasoningInRequest) {
					const thinkingText = Array.isArray(part.value) ? part.value.join("") : part.value;
					totalTokens += await textTokenLength(thinkingText);
				}
			} else {
				console.warn(`Unknown part type: ${JSON.stringify(part)}`);
			}
		}
		return totalTokens;
	}
}

/**
 * Token-count a text with a guaranteed non-zero-useful result. The precise
 * o200k tokenizer is used when available; on ANY failure we fall back to a
 * hermes-agent-style rough estimate (CJK-dense codepoints ~1 token each,
 * everything else ceil(UTF-8 bytes / 4)) instead of returning 0 — a 0 count
 * makes VS Code / the status bar treat the context as empty ("infinite
 * headroom"), which is the worst possible failure mode.
 */
export async function textTokenLength(text: string): Promise<number> {
	if (!text) {
		return 0;
	}
	try {
		return await tokenizerManager.countTokens(text);
	} catch {
		return estimateTokensRough(text);
	}
}

export async function countToolTokens(tools: readonly LanguageModelChatTool[]): Promise<number> {
	const baseToolTokens = 16;
	let numTokens = 0;
	if (tools.length) {
		numTokens += baseToolTokens;
	}

	const baseTokensPerTool = 8;
	for (const tool of tools) {
		numTokens += baseTokensPerTool;
		numTokens += await textTokenLength(JSON.stringify(tool));
	}

	return numTokens;
}

/**
 * Per-image token cost, calibrated from the provider's own usage reports
 * (ported from hermes-agent's image_token_cost): a flat constant is wrong in
 * both directions — a 1080p screenshot costs ~1,100 tokens on one provider
 * and 4,000+ on a local mmproj model. The provider prices images exactly on
 * the request that carries one, so we learn the price from the residual
 * between consecutive real prompt_tokens counts and cache it per model@host.
 */
const DEFAULT_IMAGE_TOKEN_COST = 1500;
const MIN_PLAUSIBLE_IMAGE_COST = 64;
const MAX_PLAUSIBLE_IMAGE_COST = 32768;
const IMAGE_COST_EMA_ALPHA = 0.5;

let learnedImageCost: number | undefined;

/** Record a freshly observed per-image price (clamped to the plausible band). */
export function reportLearnedImageTokenCost(observed: number): void {
	if (!Number.isFinite(observed) || observed < MIN_PLAUSIBLE_IMAGE_COST || observed > MAX_PLAUSIBLE_IMAGE_COST) {
		return;
	}
	learnedImageCost =
		learnedImageCost === undefined
			? Math.round(observed)
			: Math.round(learnedImageCost * (1 - IMAGE_COST_EMA_ALPHA) + observed * IMAGE_COST_EMA_ALPHA);
}

export function currentImageTokenCost(): number {
	return learnedImageCost ?? DEFAULT_IMAGE_TOKEN_COST;
}

function calculateImageTokenCost(imageUrl: string): number {
	// Try to read real dimensions first; unreadable images fall back to the
	// learned/flat per-image price rather than 0.
	let width = 0;
	let height = 0;
	try {
		({ width, height } = getImageDimensions(imageUrl));
	} catch {
		return currentImageTokenCost();
	}

	if (width <= 0 || height <= 0) {
		return currentImageTokenCost();
	}

	// Scale image to fit within a 2048 x 2048 square if necessary.
	if (width > 2048 || height > 2048) {
		const scaleFactor = 2048 / Math.max(width, height);
		width = Math.round(width * scaleFactor);
		height = Math.round(height * scaleFactor);
	}

	const scaleFactor = 768 / Math.min(width, height);
	width = Math.round(width * scaleFactor);
	height = Math.round(height * scaleFactor);

	const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);

	return tiles * 170 + 85;
}

function calculateNonImageBinaryTokens(byteLength: number): number {
	if (!byteLength) {
		return 0;
	}
	const base = 20;
	const per16Kb = Math.ceil(byteLength / 16384);
	return Math.min(200, base + per16Kb);
}
