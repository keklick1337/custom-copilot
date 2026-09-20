/**
 * OpenAI tool-schema → Gemini function-declaration conversion, including the
 * JSON-Schema sanitization Gemini's API requires (allOf flattening, stripping
 * unsupported keys, anyOf/oneOf handling). Extracted from geminiApi.ts.
 */

import type { OpenAIFunctionToolDef } from "../openai/openaiTypes";
import type { GeminiToolConfig } from "./geminiTypes";

const UNSUPPORTED_GEMINI_SCHEMA_KEYS = new Set(["exclusiveMinimum", "exclusiveMaximum", "enumDescriptions"]);

function stripUnsupportedGeminiSchemaKeys(value: unknown): number {
	if (!value) {
		return 0;
	}

	if (Array.isArray(value)) {
		let removed = 0;
		for (const v of value) {
			removed += stripUnsupportedGeminiSchemaKeys(v);
		}
		return removed;
	}

	if (typeof value !== "object") {
		return 0;
	}

	const obj = value as Record<string, unknown>;
	let removed = 0;

	for (const key of Object.keys(obj)) {
		if (UNSUPPORTED_GEMINI_SCHEMA_KEYS.has(key)) {
			delete obj[key];
			removed++;
			continue;
		}
		removed += stripUnsupportedGeminiSchemaKeys(obj[key]);
	}

	return removed;
}

function jsonSchemaToGeminiSchema(
	jsonSchema: unknown,
	rootSchema: unknown = jsonSchema,
	refStack: Set<string> | undefined = undefined
): Record<string, unknown> {
	if (!jsonSchema || typeof jsonSchema !== "object") {
		return {};
	}

	const root =
		rootSchema && typeof rootSchema === "object"
			? (rootSchema as Record<string, unknown>)
			: (jsonSchema as Record<string, unknown>);
	const stack = refStack instanceof Set ? refStack : new Set<string>();

	const ref =
		typeof (jsonSchema as Record<string, unknown>).$ref === "string"
			? String((jsonSchema as Record<string, unknown>).$ref).trim()
			: "";
	if (ref) {
		if (stack.has(ref)) {
			return {};
		}
		stack.add(ref);

		const resolved = (() => {
			if (ref === "#") {
				return root;
			}
			if (!ref.startsWith("#/")) {
				return null;
			}
			const decode = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
			const parts = ref
				.slice(2)
				.split("/")
				.map((p) => decode(p));

			let cur: unknown = root;
			for (const p of parts) {
				if (!cur || typeof cur !== "object") {
					return null;
				}
				if (!(p in (cur as Record<string, unknown>))) {
					return null;
				}
				cur = (cur as Record<string, unknown>)[p];
			}
			return cur && typeof cur === "object" ? (cur as Record<string, unknown>) : null;
		})();

		const merged: Record<string, unknown> = {
			...(resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {}),
			...(jsonSchema as Record<string, unknown>),
		};
		delete merged.$ref;
		const out = jsonSchemaToGeminiSchema(merged, root, stack);
		stack.delete(ref);
		return out;
	}

	const allOf = Array.isArray((jsonSchema as Record<string, unknown>).allOf)
		? ((jsonSchema as Record<string, unknown>).allOf as unknown[])
		: null;
	if (allOf && allOf.length > 0) {
		const merged: Record<string, unknown> = { ...(jsonSchema as Record<string, unknown>) };
		delete merged.allOf;
		for (const it of allOf) {
			if (!it || typeof it !== "object") {
				continue;
			}
			const itObj = it as Record<string, unknown>;
			for (const [k, v] of Object.entries(itObj)) {
				if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
					const baseProps =
						merged.properties && typeof merged.properties === "object" && !Array.isArray(merged.properties)
							? (merged.properties as Record<string, unknown>)
							: {};
					merged.properties = { ...baseProps, ...(v as Record<string, unknown>) };
					continue;
				}
				if (k === "required" && Array.isArray(v)) {
					const baseReq = Array.isArray(merged.required) ? (merged.required as unknown[]) : [];
					merged.required = Array.from(new Set([...baseReq, ...v]));
					continue;
				}
				if (!(k in merged)) {
					merged[k] = v;
				}
			}
		}
		return jsonSchemaToGeminiSchema(merged, root, stack);
	}

	const out: Record<string, unknown> = {};
	const input = { ...(jsonSchema as Record<string, unknown>) };

	// Handle nullable unions like { anyOf: [{type:'null'}, {...}] }
	const anyOf = Array.isArray(input.anyOf)
		? (input.anyOf as unknown[])
		: Array.isArray(input.oneOf)
			? (input.oneOf as unknown[])
			: null;
	if (anyOf && anyOf.length === 2) {
		const a0 = anyOf[0] && typeof anyOf[0] === "object" ? (anyOf[0] as Record<string, unknown>) : null;
		const a1 = anyOf[1] && typeof anyOf[1] === "object" ? (anyOf[1] as Record<string, unknown>) : null;
		if (a0?.type === "null") {
			out.nullable = true;
			return { ...out, ...jsonSchemaToGeminiSchema(a1, root, stack) };
		}
		if (a1?.type === "null") {
			out.nullable = true;
			return { ...out, ...jsonSchemaToGeminiSchema(a0, root, stack) };
		}
	}

	if (Array.isArray(input.type)) {
		const list = (input.type as unknown[]).filter((t) => typeof t === "string");
		if (list.length) {
			out.anyOf = list
				.filter((t) => t !== "null")
				.map((t) => jsonSchemaToGeminiSchema({ ...input, type: t, anyOf: undefined, oneOf: undefined }, root, stack));
			if (list.includes("null")) {
				out.nullable = true;
			}
			return out;
		}
	}

	for (const [k, v] of Object.entries(input)) {
		if (v == null) {
			continue;
		}
		if (k.startsWith("$")) {
			continue;
		}
		if (
			k === "additionalProperties" ||
			k === "definitions" ||
			k === "$defs" ||
			k === "title" ||
			k === "examples" ||
			k === "default"
		) {
			continue;
		}

		// Gemini Schema doesn't support Draft-07 exclusive bounds fields.
		// Best-effort: map numeric exclusive bounds to inclusive ones.
		if (k === "exclusiveMinimum") {
			if (typeof v === "number" && !("minimum" in out)) {
				out.minimum = v;
			}
			continue;
		}
		if (k === "exclusiveMaximum") {
			if (typeof v === "number" && !("maximum" in out)) {
				out.maximum = v;
			}
			continue;
		}
		if (k === "allOf") {
			continue;
		}

		if (k === "type") {
			if (typeof v !== "string") {
				continue;
			}
			if (v === "null") {
				continue;
			}
			out.type = String(v).toUpperCase();
			continue;
		}

		if (k === "const") {
			if (!("enum" in out)) {
				out.enum = [v];
			}
			continue;
		}

		if (k === "items") {
			if (v && typeof v === "object") {
				out.items = jsonSchemaToGeminiSchema(v, root, stack);
			}
			continue;
		}

		if (k === "properties") {
			if (v && typeof v === "object" && !Array.isArray(v)) {
				const m: Record<string, unknown> = {};
				for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
					if (pv && typeof pv === "object") {
						m[pk] = jsonSchemaToGeminiSchema(pv, root, stack);
					}
				}
				out.properties = m;
			}
			continue;
		}

		if (k === "anyOf" || k === "oneOf") {
			if (Array.isArray(v)) {
				const arr: unknown[] = [];
				for (const it of v) {
					if (it && typeof it === "object") {
						arr.push(jsonSchemaToGeminiSchema(it, root, stack));
					}
				}
				out.anyOf = arr;
			}
			continue;
		}

		(out as Record<string, unknown>)[k] = v;
	}

	// Gemini Schema types are enum-like uppercase strings; if absent but properties exist, treat as OBJECT.
	if (!out.type && out.properties && typeof out.properties === "object") {
		out.type = "OBJECT";
	}

	return out;
}

export function openaiToolsToGeminiFunctionDeclarations(
	tools: OpenAIFunctionToolDef[]
): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> {
	const out: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> = [];
	for (const t of Array.isArray(tools) ? tools : []) {
		if (!t || typeof t !== "object") {
			continue;
		}
		if (t.type !== "function") {
			continue;
		}
		const fn = t.function;
		const name = typeof fn?.name === "string" ? fn.name.trim() : "";
		if (!name) {
			continue;
		}
		const decl: { name: string; description?: string; parameters?: Record<string, unknown> } = { name };
		if (typeof fn.description === "string" && fn.description.trim()) {
			decl.description = fn.description;
		}
		if (fn.parameters && typeof fn.parameters === "object") {
			decl.parameters = jsonSchemaToGeminiSchema(fn.parameters);
			stripUnsupportedGeminiSchemaKeys(decl.parameters);
		}
		out.push(decl);
	}
	return out;
}

export function openaiToolChoiceToGeminiToolConfig(toolChoice: unknown): GeminiToolConfig | null {
	if (toolChoice == null) {
		return null;
	}

	if (typeof toolChoice === "string") {
		const v = toolChoice.trim().toLowerCase();
		if (v === "none") {
			return { functionCallingConfig: { mode: "NONE" } };
		}
		if (v === "required" || v === "any") {
			return { functionCallingConfig: { mode: "ANY" } };
		}
		return { functionCallingConfig: { mode: "AUTO" } };
	}

	if (typeof toolChoice === "object") {
		const obj = toolChoice as Record<string, unknown>;
		if (obj.type === "function") {
			const fn = obj.function && typeof obj.function === "object" ? (obj.function as Record<string, unknown>) : null;
			const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
			if (name) {
				return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
			}
		}
	}

	return null;
}