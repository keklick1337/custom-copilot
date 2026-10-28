/**
 * Translate OpenAI-style tool schemas to Moonshot's (Kimi) stricter JSON
 * Schema subset — ported from hermes-agent `agent/moonshot_schema.py`.
 * Violations fail with HTTP 400 "tools.function.parameters is not a valid
 * moonshot flavored json schema". Rules: (1) every property schema carries a
 * `type`; (2) with `anyOf`, `type` belongs on the children and null branches
 * are dropped; (3) scalar enums carry no null / "" values; (4) every object
 * schema has a `required` array naming only declared properties.
 */

type Schema = Record<string, unknown>;

const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_NODE_KEYS = new Set(["items", "contains", "not", "additionalProperties", "propertyNames", "if", "then", "else"]);
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

function isObject(v: unknown): v is Schema {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function emptyObjectSchema(): Schema {
	return { type: "object", properties: {}, required: [] };
}

function ensureRequiredArray(node: Schema): Schema {
	const props = node.properties;
	const req = node.required;
	if (Array.isArray(req)) {
		if (isObject(props)) {
			node.required = req.filter((r) => typeof r === "string" && r in props);
		}
	} else {
		node.required = [];
	}
	return node;
}

function fillMissingType(node: Schema): Schema {
	const nodeType = node.type;
	if (Array.isArray(nodeType)) {
		const concrete = nodeType.find((t) => typeof t === "string" && t !== "" && t !== "null") ?? "string";
		return { ...node, type: concrete };
	}
	if ("type" in node && nodeType !== null && nodeType !== undefined && nodeType !== "") {
		return node;
	}
	let inferred: string;
	if ("properties" in node || "required" in node || "additionalProperties" in node) {
		inferred = "object";
	} else if ("items" in node || "prefixItems" in node) {
		inferred = "array";
	} else if (Array.isArray(node.enum) && node.enum.length > 0) {
		const sample = node.enum[0];
		inferred =
			typeof sample === "boolean"
				? "boolean"
				: typeof sample === "number"
					? Number.isInteger(sample)
						? "integer"
						: "number"
					: "string";
	} else if ("if" in node || "then" in node || "else" in node) {
		return node;
	} else {
		inferred = "string";
	}
	return { ...node, type: inferred };
}

function repairSchema(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map(repairSchema);
	}
	if (!isObject(node)) {
		return node;
	}
	let repaired: Schema = {};
	for (const [key, value] of Object.entries(node)) {
		if (SCHEMA_MAP_KEYS.has(key) && isObject(value)) {
			repaired[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repairSchema(v)]));
		} else if ((SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) || (SCHEMA_NODE_KEYS.has(key) && isObject(value))) {
			repaired[key] = repairSchema(value);
		} else {
			repaired[key] = value;
		}
	}

	// Rule 2 + drop null branches; a single survivor is promoted.
	if (Array.isArray(repaired.anyOf)) {
		delete repaired.type;
		const branches = repaired.anyOf as unknown[];
		const nonNull = branches.filter((b) => isObject(b) && b.type !== "null") as Schema[];
		if (nonNull.length === 0 || nonNull.length === branches.length) {
			return repaired;
		}
		if (nonNull.length > 1) {
			repaired.anyOf = nonNull;
			return repaired;
		}
		const rest: Schema = { ...repaired };
		delete rest.anyOf;
		repaired = { ...rest, ...nonNull[0] };
	}

	// Moonshot rejects the non-standard `nullable` keyword.
	delete repaired.nullable;

	// Rule 1 ($ref nodes take their type from the definition).
	if (!("$ref" in repaired)) {
		repaired = fillMissingType(repaired);
	}

	// Rule 3.
	if (Array.isArray(repaired.enum) && SCALAR_TYPES.has(String(repaired.type))) {
		const cleaned = (repaired.enum as unknown[]).filter((v) => v !== null && v !== "");
		if (cleaned.length > 0) {
			repaired.enum = cleaned;
		} else {
			delete repaired.enum;
		}
	}

	// Rule 4.
	if (repaired.type === "object") {
		repaired = ensureRequiredArray(repaired);
	}
	return repaired;
}

/** Moonshot-compatible object schema (input is not mutated). */
export function sanitizeMoonshotToolParameters(parameters: unknown): Schema {
	if (!isObject(parameters)) {
		return emptyObjectSchema();
	}
	const repaired = repairSchema(JSON.parse(JSON.stringify(parameters)));
	if (!isObject(repaired)) {
		return emptyObjectSchema();
	}
	repaired.type = "object";
	if (!isObject(repaired.properties)) {
		repaired.properties = {};
	}
	return ensureRequiredArray(repaired);
}

/** True for any Kimi / Moonshot model slug, regardless of aggregator prefix. */
export function isMoonshotModel(model: string | null | undefined): boolean {
	if (!model) {
		return false;
	}
	const bare = model.trim().toLowerCase();
	const tail = bare.slice(bare.lastIndexOf("/") + 1);
	if (tail.startsWith("kimi-") || tail === "kimi") {
		return true;
	}
	if (tail === "k3" || tail.startsWith("k3.") || tail.startsWith("k3-")) {
		return true;
	}
	return bare.includes("moonshot") || bare.includes("/kimi") || bare.startsWith("kimi");
}
