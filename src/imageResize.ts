import { createHash } from "crypto";
import * as vscode from "vscode";
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { logger } from "./logger";

/**
 * Downscale oversized chat images before they reach the model. Copilot only
 * resizes attachments in the renderer (and only when BOTH sides exceed 768),
 * so 4K screenshots from tools/MCP arrive raw — on GLM vision that is up to
 * ~1M tokens per image. Mirrors ZCode's jimp pipeline in pure JS: fit the long
 * edge, re-encode as JPEG with a quality ladder until the byte budget fits.
 */

export const DEFAULT_IMAGE_MAX_DIMENSION = 2048;
/** ZCode: 5 MiB base64 ≈ 3.75 MiB raw. */
const MAX_RAW_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
const JPEG_QUALITIES = [85, 75, 60, 45];
/** Refuse to decode absurd images (memory guard for the extension host). */
const MAX_DECODE_MEGAPIXELS = 100;
const CACHE_LIMIT = 64;

const cache = new Map<string, { data: Uint8Array; mimeType: string }>();

interface Rgba {
	width: number;
	height: number;
	data: Uint8Array;
}

/** Header-only dimensions for PNG / JPEG / GIF / WebP; undefined when unknown. */
export function imageSizeFromBytes(b: Uint8Array): { width: number; height: number } | undefined {
	if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
		return { width: v.getUint32(16), height: v.getUint32(20) };
	}
	if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
		return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		let o = 2;
		while (o + 9 < b.length) {
			if (b[o] !== 0xff) {
				o++;
				continue;
			}
			const marker = b[o + 1];
			const len = (b[o + 2] << 8) | b[o + 3];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
			}
			o += 2 + len;
		}
		return undefined;
	}
	if (b.length >= 30 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
		const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
		if (chunk === "VP8X") {
			return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
		}
		if (chunk === "VP8L") {
			const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8 ") {
			return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
		}
	}
	return undefined;
}

/** Target size: long edge ≤ maxDimension, never upscaled. */
export function fitWithin(width: number, height: number, maxDimension: number): { width: number; height: number } {
	const longSide = Math.max(width, height);
	if (maxDimension <= 0 || longSide <= maxDimension) {
		return { width, height };
	}
	const scale = maxDimension / longSide;
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function decode(bytes: Uint8Array, mimeType: string): Rgba | undefined {
	const mime = mimeType.toLowerCase();
	if (mime === "image/png") {
		const png = PNG.sync.read(Buffer.from(bytes));
		return { width: png.width, height: png.height, data: png.data };
	}
	if (mime === "image/jpeg" || mime === "image/jpg") {
		const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_DECODE_MEGAPIXELS });
		return { width: img.width, height: img.height, data: img.data };
	}
	return undefined;
}

/** Area-average downscale (no aliasing on text-heavy screenshots). */
function downscale(src: Rgba, width: number, height: number): Rgba {
	if (width === src.width && height === src.height) {
		return src;
	}
	const out = new Uint8Array(width * height * 4);
	const xRatio = src.width / width;
	const yRatio = src.height / height;
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor(y * yRatio);
		const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * xRatio);
			const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let sy = y0; sy < y1; sy++) {
				let i = (sy * src.width + x0) * 4;
				for (let sx = x0; sx < x1; sx++, i += 4) {
					const alpha = src.data[i + 3];
					r += src.data[i] * alpha;
					g += src.data[i + 1] * alpha;
					b += src.data[i + 2] * alpha;
					a += alpha;
				}
			}
			const o = (y * width + x) * 4;
			const n = (y1 - y0) * (x1 - x0);
			if (a > 0) {
				out[o] = Math.round(r / a);
				out[o + 1] = Math.round(g / a);
				out[o + 2] = Math.round(b / a);
			}
			out[o + 3] = Math.round(a / n);
		}
	}
	return { width, height, data: out };
}

function hasTransparency(img: Rgba): boolean {
	for (let i = 3; i < img.data.length; i += 4) {
		if (img.data[i] < 250) {
			return true;
		}
	}
	return false;
}

/** JPEG has no alpha: composite onto white so transparent areas don't turn black. */
function flattenOnWhite(img: Rgba): Rgba {
	const data = new Uint8Array(img.data.length);
	for (let i = 0; i < img.data.length; i += 4) {
		const a = img.data[i + 3] / 255;
		data[i] = Math.round(img.data[i] * a + 255 * (1 - a));
		data[i + 1] = Math.round(img.data[i + 1] * a + 255 * (1 - a));
		data[i + 2] = Math.round(img.data[i + 2] * a + 255 * (1 - a));
		data[i + 3] = 255;
	}
	return { width: img.width, height: img.height, data };
}

function encodePng(img: Rgba): Uint8Array {
	const png = new PNG({ width: img.width, height: img.height });
	png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
	return PNG.sync.write(png, { deflateLevel: 9 });
}

function encodeJpegWithinBudget(img: Rgba): Uint8Array {
	const flat = flattenOnWhite(img);
	let last: Uint8Array = new Uint8Array();
	for (const q of JPEG_QUALITIES) {
		last = jpeg.encode({ width: flat.width, height: flat.height, data: flat.data }, q).data;
		if (last.byteLength <= MAX_RAW_BYTES) {
			return last;
		}
	}
	return last;
}

/**
 * Downscale/re-encode one image when it exceeds `maxDimension` (long edge) or
 * the byte budget. Returns the input unchanged when nothing needs doing, the
 * format is unsupported (GIF/WebP), or the result would not be smaller.
 */
export function shrinkImage(
	bytes: Uint8Array,
	mimeType: string,
	maxDimension: number
): { data: Uint8Array; mimeType: string; changed: boolean } {
	const size = imageSizeFromBytes(bytes);
	const tooBig = bytes.byteLength > MAX_RAW_BYTES;
	const needsResize = !!size && maxDimension > 0 && Math.max(size.width, size.height) > maxDimension;
	if (!needsResize && !tooBig) {
		return { data: bytes, mimeType, changed: false };
	}
	const key = `${maxDimension}:${createHash("sha1").update(bytes).digest("hex")}`;
	const hit = cache.get(key);
	if (hit) {
		return { ...hit, changed: hit.data !== bytes };
	}
	const started = Date.now();
	try {
		if (size && size.width * size.height > MAX_DECODE_MEGAPIXELS * 1_000_000) {
			return { data: bytes, mimeType, changed: false };
		}
		const decoded = decode(bytes, mimeType);
		if (!decoded) {
			return { data: bytes, mimeType, changed: false };
		}
		const target = fitWithin(decoded.width, decoded.height, maxDimension);
		const scaled = downscale(decoded, target.width, target.height);
		let outData: Uint8Array;
		let outMime: string;
		if (mimeType.toLowerCase() === "image/png" && hasTransparency(scaled)) {
			outData = encodePng(scaled);
			outMime = "image/png";
			if (outData.byteLength > MAX_RAW_BYTES) {
				outData = encodeJpegWithinBudget(scaled);
				outMime = "image/jpeg";
			}
		} else {
			outData = encodeJpegWithinBudget(scaled);
			outMime = "image/jpeg";
		}
		const keepOriginal = outData.byteLength >= bytes.byteLength && !needsResize;
		const result = keepOriginal ? { data: bytes, mimeType } : { data: outData, mimeType: outMime };
		cache.set(key, result);
		if (cache.size > CACHE_LIMIT) {
			cache.delete(cache.keys().next().value as string);
		}
		logger.info("image.shrink", {
			from: size ? `${size.width}x${size.height}` : "?",
			to: `${target.width}x${target.height}`,
			bytesIn: bytes.byteLength,
			bytesOut: result.data.byteLength,
			mime: result.mimeType,
			ms: Date.now() - started,
		});
		return { ...result, changed: !keepOriginal };
	} catch (err) {
		logger.warn("image.shrink.failed", { mimeType, error: err instanceof Error ? err.message : String(err) });
		return { data: bytes, mimeType, changed: false };
	}
}

function shrinkPart(part: vscode.LanguageModelDataPart, maxDimension: number): vscode.LanguageModelDataPart {
	const r = shrinkImage(part.data, part.mimeType, maxDimension);
	return r.changed ? new vscode.LanguageModelDataPart(r.data, r.mimeType) : part;
}

function isImagePart(p: unknown): p is vscode.LanguageModelDataPart {
	return p instanceof vscode.LanguageModelDataPart && p.mimeType.toLowerCase().startsWith("image/");
}

/**
 * Return messages with every oversized image (user attachments and tool
 * results) downscaled. Messages without images are returned as-is.
 */
export function shrinkMessageImages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	maxDimension: number
): readonly vscode.LanguageModelChatRequestMessage[] {
	if (maxDimension <= 0) {
		return messages;
	}
	let anyChanged = false;
	const out = messages.map((m) => {
		let changed = false;
		const content = (m.content ?? []).map((part) => {
			if (isImagePart(part)) {
				const next = shrinkPart(part, maxDimension);
				changed ||= next !== part;
				return next;
			}
			if (part instanceof vscode.LanguageModelToolResultPart && part.content.some(isImagePart)) {
				let inner = false;
				const items = part.content.map((c) => {
					if (isImagePart(c)) {
						const next = shrinkPart(c, maxDimension);
						inner ||= next !== c;
						return next;
					}
					return c;
				});
				if (inner) {
					changed = true;
					return new vscode.LanguageModelToolResultPart(part.callId, items);
				}
			}
			return part;
		});
		if (!changed) {
			return m;
		}
		anyChanged = true;
		return { role: m.role, name: m.name, content } as vscode.LanguageModelChatRequestMessage;
	});
	return anyChanged ? out : messages;
}
