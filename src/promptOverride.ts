import * as vscode from "vscode";
import type { LanguageModelChatRequestMessage } from "vscode";
import { logger } from "./logger";
import { captureSystemPrompt } from "./promptCapture";

/**
 * How the user-defined override `text` is combined with the system prompt that
 * Copilot Chat assembled and sent to us.
 *
 * - `off`      — do not touch the system text with `text` (find/replace rules
 *                may still run).
 * - `append`   — keep the original system text, add `text` after it.
 * - `prepend`  — add `text` before the original system text.
 * - `replace`  — discard the original system text entirely, use only `text`.
 */
export type PromptOverrideMode = "off" | "append" | "prepend" | "replace";

/**
 * A surgical find/replace applied to the (already combined) system text. This
 * is how individual *parts* of the default prompt are rewritten — e.g.
 * swapping Copilot's `SafetyRules` block for stricter, custom rules.
 */
export interface PromptReplacement {
	find: string;
	replace: string;
	/** When true, `find` is treated as a regular expression. */
	isRegex?: boolean;
	/** Regex flags (default "g"). Ignored unless `isRegex` is true. */
	flags?: string;
}

interface PromptOverrideConfig {
	enabled: boolean;
	mode: PromptOverrideMode;
	text: string;
	replacements: PromptReplacement[];
}

/** Per-rule diagnostics produced by {@link testPromptOverride}. */
export interface ReplacementDiagnostic {
	index: number;
	find: string;
	isRegex: boolean;
	/** Number of matches the rule made, or `null` when the regex was invalid. */
	matches: number | null;
	error?: string;
}

/** Result of a dry-run override, used by the "Test" button in the UI. */
export interface PromptOverrideTestResult {
	/** The original (captured) system text the test ran against. */
	original: string;
	/** The text after combine + all replacement rules. */
	result: string;
	/** Per-rule match counts / errors. */
	diagnostics: ReplacementDiagnostic[];
}

const TEXT_SEPARATOR = "\n\n";

// The proposed `LanguageModelChatMessageRole` type only declares `User` and
// `Assistant`; a system message is anything that is neither (this mirrors how
// `mapRole` in utils.ts classifies roles). Resolve the numeric values once.
const ROLE_USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
const ROLE_ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
// Use the runtime `System` value if present, else a sentinel that is neither
// User nor Assistant so downstream adapters classify it as system.
const ROLE_SYSTEM =
	(vscode.LanguageModelChatMessageRole as unknown as Record<string, number>).System ?? 0;

/** A message is a system message when its role is neither User nor Assistant. */
function isSystemMessage(message: LanguageModelChatRequestMessage): boolean {
	const r = message.role as unknown as number;
	return r !== ROLE_USER && r !== ROLE_ASSISTANT;
}

/** Normalise a raw settings value into a clean list of replacement rules. */
function normalizeReplacements(rawReplacements: unknown): PromptReplacement[] {
	return Array.isArray(rawReplacements)
		? rawReplacements
				.filter(
					(r): r is PromptReplacement =>
						!!r && typeof r === "object" && typeof (r as PromptReplacement).find === "string"
				)
				.map((r) => ({
					find: r.find,
					replace: typeof r.replace === "string" ? r.replace : "",
					isRegex: !!r.isRegex,
					flags: typeof r.flags === "string" && r.flags ? r.flags : "g",
				}))
		: [];
}

/**
 * Read and normalise the prompt-override configuration from settings.
 * Returns `undefined` when the feature is disabled or there is nothing to do.
 */
function readConfig(): PromptOverrideConfig | undefined {
	const config = vscode.workspace.getConfiguration();
	const enabled = config.get<boolean>("customcopilot.promptOverride.enabled", false);
	if (!enabled) {
		return undefined;
	}
	const mode = config.get<PromptOverrideMode>("customcopilot.promptOverride.mode", "append");
	const text = config.get<string>("customcopilot.promptOverride.text", "") ?? "";
	const replacements = normalizeReplacements(config.get<unknown>("customcopilot.promptOverride.replacements", []));

	// Nothing to apply: no text change requested and no replacement rules.
	const hasTextChange = mode !== "off" && text.trim().length > 0;
	if (!hasTextChange && replacements.length === 0) {
		return undefined;
	}
	return { enabled, mode, text, replacements };
}

/** Extract the concatenated text content of a single chat message. */
function getMessageText(message: LanguageModelChatRequestMessage): string {
	const parts: string[] = [];
	for (const part of message.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			parts.push(part.value);
		}
	}
	return parts.join("");
}

/** Apply the configured find/replace rules to the system text. */
function applyReplacements(text: string, replacements: PromptReplacement[]): string {
	let result = text;
	for (const rule of replacements) {
		if (!rule.find) {
			continue;
		}
		try {
			if (rule.isRegex) {
				const re = new RegExp(rule.find, rule.flags ?? "g");
				result = result.replace(re, rule.replace);
			} else {
				// Plain-text replace of ALL occurrences (split/join avoids needing to escape).
				result = result.split(rule.find).join(rule.replace);
			}
		} catch (e) {
			// A bad regex must never break the request — skip the rule and log it.
			logger.warn("promptOverride.replacement.error", {
				find: rule.find,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
	return result;
}

/** Combine the original system text with the override `text` per the mode. */
function combineText(original: string, mode: PromptOverrideMode, text: string): string {
	const extra = text.trim().length > 0 ? text : "";
	switch (mode) {
		case "replace":
			return extra;
		case "prepend":
			return extra ? (original ? extra + TEXT_SEPARATOR + original : extra) : original;
		case "append":
			return extra ? (original ? original + TEXT_SEPARATOR + extra : extra) : original;
		case "off":
		default:
			return original;
	}
}

/**
 * Build a system message object carrying the given text. Uses
 * `vscode.LanguageModelTextPart` for content so the downstream adapters
 * (which test `instanceof LanguageModelTextPart`) read it correctly.
 */
function makeSystemMessage(
	text: string,
	template?: LanguageModelChatRequestMessage
): LanguageModelChatRequestMessage {
	const role = template ? template.role : (ROLE_SYSTEM as unknown as vscode.LanguageModelChatMessageRole);
	return {
		role,
		name: template?.name,
		content: [new vscode.LanguageModelTextPart(text)],
	} as unknown as LanguageModelChatRequestMessage;
}

/**
 * Dry-run the override against a given system text and report what each rule
 * did. Pure function used by the configuration UI's "Test" button so the user
 * can preview (and diff) the effect of their mode/text/replacements before
 * saving — without sending a real chat request.
 *
 * @param originalText The captured original system prompt to test against.
 * @param mode How `text` is combined with `originalText`.
 * @param text The custom override text.
 * @param replacements The (possibly unsaved) find/replace rules to apply.
 */
export function testPromptOverride(
	originalText: string,
	mode: PromptOverrideMode,
	text: string,
	replacements: PromptReplacement[]
): PromptOverrideTestResult {
	const rules = normalizeReplacements(replacements);
	const combined = combineText(originalText ?? "", mode, text ?? "");

	const diagnostics: ReplacementDiagnostic[] = [];
	let result = combined;
	rules.forEach((rule, index) => {
		if (!rule.find) {
			diagnostics.push({ index, find: rule.find, isRegex: !!rule.isRegex, matches: 0 });
			return;
		}
		try {
			if (rule.isRegex) {
				// Count matches with a global clone of the regex (independent of `flags`).
				const countFlags = (rule.flags ?? "g").includes("g") ? rule.flags ?? "g" : (rule.flags ?? "") + "g";
				const countRe = new RegExp(rule.find, countFlags);
				const matches = (result.match(countRe) || []).length;
				const re = new RegExp(rule.find, rule.flags ?? "g");
				result = result.replace(re, rule.replace);
				diagnostics.push({ index, find: rule.find, isRegex: true, matches });
			} else {
				const parts = result.split(rule.find);
				const matches = parts.length - 1;
				result = parts.join(rule.replace);
				diagnostics.push({ index, find: rule.find, isRegex: false, matches });
			}
		} catch (e) {
			diagnostics.push({
				index,
				find: rule.find,
				isRegex: !!rule.isRegex,
				matches: null,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	});

	return { original: originalText ?? "", result, diagnostics };
}

/**
 * Rewrite the system prompt that Copilot Chat sent us according to the user's
 * `customcopilot.promptOverride.*` settings.
 *
 * This extension is a *provider*: Copilot assembles the full system prompt
 * (its identity, safety rules, tool instructions, etc.) and hands it to us as
 * `messages`. There is no way to change Copilot's prompt builder from here, so
 * the only effective override is to intercept those messages and rewrite the
 * system text before forwarding it to the configured endpoint.
 *
 * Behaviour (only when `customcopilot.promptOverride.enabled` is true):
 * 1. All system messages are merged into a single effective system text.
 * 2. The `mode`/`text` settings combine the user text with that original text.
 * 3. The find/replace `replacements` rewrite individual parts (e.g. the safety
 *    block) of the resulting text.
 * 4. The result replaces the first system message; any other system messages
 *    are dropped. A new system message is created if none existed.
 *
 * Non-system messages (user / assistant / tool) are always passed through
 * unchanged. On any unexpected error the original messages are returned so a
 * misconfiguration can never break chat.
 */
export function applyPromptOverride(
	messages: readonly LanguageModelChatRequestMessage[],
	modelId?: string
): readonly LanguageModelChatRequestMessage[] {
	// Always capture the ORIGINAL system prompt first (even when the override
	// feature is disabled), so the user can view it in the UI and base their
	// rewrite on it. This must run before any config gating or rewriting.
	const systemIndices: number[] = [];
	const originalSystemParts: string[] = [];
	messages.forEach((m, i) => {
		if (isSystemMessage(m)) {
			systemIndices.push(i);
			originalSystemParts.push(getMessageText(m));
		}
	});
	const originalSystemText = originalSystemParts.join(TEXT_SEPARATOR);
	if (originalSystemText.trim().length > 0) {
		captureSystemPrompt(originalSystemText, modelId);
	}

	let cfg: PromptOverrideConfig | undefined;
	try {
		cfg = readConfig();
	} catch (e) {
		logger.warn("promptOverride.config.error", { error: e instanceof Error ? e.message : String(e) });
		return messages;
	}
	if (!cfg) {
		return messages;
	}

	try {
		let effective = combineText(originalSystemText, cfg.mode, cfg.text);
		effective = applyReplacements(effective, cfg.replacements);

		const firstSystemIndex = systemIndices.length > 0 ? systemIndices[0] : -1;
		const dropIndices = new Set(systemIndices.slice(1));

		const out: LanguageModelChatRequestMessage[] = [];
		const hasEffective = effective.trim().length > 0;

		// No system message existed but we have text to inject — prepend one.
		if (firstSystemIndex === -1) {
			if (hasEffective) {
				out.push(makeSystemMessage(effective));
			}
			for (const m of messages) {
				out.push(m);
			}
			logger.debug("promptOverride.applied", {
				mode: cfg.mode,
				createdSystem: hasEffective,
				replacements: cfg.replacements.length,
			});
			return out;
		}

		messages.forEach((m, i) => {
			if (i === firstSystemIndex) {
				if (hasEffective) {
					out.push(makeSystemMessage(effective, m));
				}
				// If effective is empty, the system message is dropped entirely.
				return;
			}
			if (dropIndices.has(i)) {
				return;
			}
			out.push(m);
		});

		logger.debug("promptOverride.applied", {
			mode: cfg.mode,
			mergedSystemMessages: systemIndices.length,
			replacements: cfg.replacements.length,
			resultLength: effective.length,
		});
		return out;
	} catch (e) {
		logger.warn("promptOverride.apply.error", { error: e instanceof Error ? e.message : String(e) });
		return messages;
	}
}