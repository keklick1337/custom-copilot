/**
 * Rough token estimation, ported from hermes-agent's `estimate_tokens_rough`
 * (agent/model_metadata.py). Used as the fallback when the precise o200k
 * tokenizer is unavailable — never returns a misleading 0 for non-empty text.
 *
 * - CJK/Hangul/Kana codepoints cost ~1 token each (they are token-dense);
 * - everything else costs ceil(UTF-8 bytes / 4) — byte-counting (not chars)
 *   corrects for Cyrillic/Greek/Arabic, which run ~2-3 chars/token where a
 *   naive chars/4 under-counts ~2x.
 */

const CHARS_PER_TOKEN = 4;

const CJK_DENSE_RE = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokensRough(text: string): number {
	if (!text) {
		return 0;
	}
	// Fast path: pure ASCII cannot contain token-dense CJK.
	let isAscii = true;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7f) {
			isAscii = false;
			break;
		}
	}
	if (isAscii) {
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}
	const dense = (text.match(CJK_DENSE_RE) ?? []).length;
	const strippedByteLength = Buffer.byteLength(text.replace(CJK_DENSE_RE, ""), "utf8");
	return dense + Math.ceil(strippedByteLength / CHARS_PER_TOKEN);
}
