import * as vscode from "vscode";
import { VENDOR_MODES } from "../vendorModes";
import { AGENT_TOOL_NAMES } from "./agentNames";

/** Shared by the main-chat tools and nested (agent → agent) spawning. */

const OWN_VENDORS = new Set(VENDOR_MODES.map((v) => v.vendor));
/**
 * Safety cap on tool rounds per run. Like Claude Code, agents have NO round
 * limit by default (they run until done; auto-compaction keeps the context
 * in bounds) — this only stops a runaway loop. A limit can still be set per
 * agent (`maxSteps`), per custom agent type (`maxTurns`) or globally.
 */
export const HARD_MAX_STEPS = 500;
/** Identical tool rounds in a row before the agent is warned / stopped. */
export const REPEAT_WARN = 3;
export const REPEAT_STOP = 6;
const OWN_AGENT_TOOLS = new Set<string>(Object.values(AGENT_TOOL_NAMES));

/** Words (name split on _ / - / . / camelCase) that mark a read-only tool. */
const READ_ONLY_WORDS = new Set([
	"read",
	"search",
	"grep",
	"find",
	"list",
	"get",
	"fetch",
	"semantic",
	"codebase",
	"usages",
	"symbol",
	"symbols",
	"errors",
	"problems",
	"diagnostic",
	"diagnostics",
	"view",
	"open",
	"lookup",
	"files",
	"structure",
	"summary",
	"output",
	"resolve",
	"docs",
	"documentation",
	"describe",
	"inspect",
	"info",
	"status",
	"diff",
]);
/** Words that indicate side effects / UI interaction; they win over READ_ONLY_WORDS. */
const WRITE_WORDS = new Set([
	"edit",
	"write",
	"create",
	"delete",
	"remove",
	"rename",
	"replace",
	"insert",
	"apply",
	"patch",
	"run",
	"terminal",
	"exec",
	"execute",
	"install",
	"commit",
	"push",
	"move",
	"send",
	"kill",
	"task",
	"delegate",
	"subagent",
	"todo",
	"manage",
	"confirmation",
	"question",
	"ask",
	"memory",
	"switch",
	"review",
	"plan",
	"set",
	"update",
	"save",
]);
/** Read-only tools whose names contain a write word. */
const READ_ONLY_EXCEPTIONS = new Set(["skill", "copilot_getNotebookSummary", "copilot_readNotebookCellOutput"]);
/**
 * Tools a background agent must never get: Copilot's own edit/terminal tools
 * only work inside Copilot's agent loop (they need its prompt context / a live
 * chat request token) — subagents use their own write tools instead.
 */
const NEVER_FOR_AGENTS = /^(copilot_|vscode_|run_in_terminal|get_terminal_output|manage_todo_list|runSubagent)|runsubagent/i;

/**
 * Whether the main chat offers this tool. Copilot's own tools reach the model
 * under other names ("read_file" for copilot_readFile), so they are always
 * kept; MCP / extension tools keep their names and follow the tool picker.
 * Ignored when too few names match (unknown naming scheme).
 */
function inMainChat(name: string, mainTools: ReadonlySet<string> | undefined): boolean {
	if (!mainTools?.size || name.startsWith("copilot_")) {
		return true;
	}
	const known = vscode.lm.tools.filter((t) => mainTools.has(t.name)).length;
	return known < 3 || mainTools.has(name);
}

function nameWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Tools that may have side effects (edits, commands, UI prompts) by name. */
function isWriteTool(tool: vscode.LanguageModelToolInformation): boolean {
	if (READ_ONLY_EXCEPTIONS.has(tool.name)) {
		return false;
	}
	return nameWords(tool.name).some((w) => WRITE_WORDS.has(w));
}

/** Read-only by name: a read word and no write word (the read-only agents' allow-list). */
export function isReadOnlyTool(tool: vscode.LanguageModelToolInformation): boolean {
	return !isWriteTool(tool) && nameWords(tool.name).some((w) => READ_ONLY_WORDS.has(w));
}

/** In-process write tools of write-enabled agents (handled by the agent loop). */
export const AGENT_WRITE_TOOLS: vscode.LanguageModelChatTool[] = [
	{
		name: AGENT_TOOL_NAMES.editFile,
		description:
			"Replace an exact string in a workspace file. `oldString` must match exactly once (include enough surrounding lines to be unique) unless replaceAll is true. Read the file first.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path (or relative to your working directory) inside the workspace — or inside your worktree when you have one." },
				oldString: { type: "string", description: "Exact text to replace (whitespace and indentation must match)." },
				newString: { type: "string", description: "Replacement text." },
				replaceAll: { type: "boolean", description: "Replace every occurrence. Default false." },
			},
			required: ["path", "oldString", "newString"],
		},
	},
	{
		name: AGENT_TOOL_NAMES.createFile,
		description: "Create a file in the workspace with the given content (parent folders are created). Fails if it exists unless overwrite is true.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path (or relative to your working directory) inside the workspace — or inside your worktree when you have one." },
				content: { type: "string", description: "Full file content." },
				overwrite: { type: "boolean", description: "Replace an existing file. Default false." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: AGENT_TOOL_NAMES.runCommand,
		description:
			"Run a shell command in the workspace (the user confirms each command unless they allowed all for this agent). Returns exit code and output (truncated). Use for builds, tests, linters, git status. Not for long-running servers.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command line." },
				cwd: { type: "string", description: "Working directory (absolute, or relative to your working directory). Default: your working directory (the workspace root, or your worktree)." },
				timeoutSeconds: { type: "number", description: "Kill after this many seconds (default 120, max 900)." },
			},
			required: ["command"],
		},
	},
];

/**
 * Tools of an agent: read-only workspace tools (+ write-capable ones with
 * allowWrite), coordination tools, and our own terminal / edit tools. A
 * custom agent type may restrict the workspace tools (`tools`, exact VS Code
 * tool names) or exclude some (`disallowedTools`).
 */
export function pickTools(
	allowWrite: boolean,
	canSpawn: boolean,
	limits?: { tools?: string[]; disallowedTools?: string[]; mainTools?: ReadonlySet<string> }
): vscode.LanguageModelChatTool[] {
	const toChatTool = (t: vscode.LanguageModelToolInformation): vscode.LanguageModelChatTool => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema ?? { type: "object", properties: {} },
	});
	const workspace = vscode.lm.tools
		.filter((t) => !OWN_AGENT_TOOLS.has(t.name) && !/delegate|subagent/i.test(t.name))
		// Read-only agents: tools whose NAME says read/search only (allow-list —
		// unknown tools such as browser_click or merge_pull_request stay out);
		// write-enabled agents: everything except Copilot's loop-bound tools.
		.filter((t) => isReadOnlyTool(t) || (allowWrite && !NEVER_FOR_AGENTS.test(t.name)))
		// The same tools the main chat has enabled (its tool picker), when known.
		.filter((t) => inMainChat(t.name, limits?.mainTools))
		.filter((t) => !limits?.tools || limits.tools.includes(t.name))
		.filter((t) => !limits?.disallowedTools?.includes(t.name))
		.map(toChatTool);
	// Coordination tools (handled in-process by the agent loop).
	const coordination = vscode.lm.tools
		.filter(
			(t) =>
				t.name === AGENT_TOOL_NAMES.list ||
				t.name === AGENT_TOOL_NAMES.send ||
				t.name === AGENT_TOOL_NAMES.wait ||
				// Nested subagents (Claude Code style) while the depth limit allows.
				(canSpawn &&
					(t.name === AGENT_TOOL_NAMES.run || t.name === AGENT_TOOL_NAMES.stop || t.name === AGENT_TOOL_NAMES.resume))
		)
		.map(toChatTool);
	// Every agent gets its own terminal (run command); file edit/create only with allowWrite.
	const ownTools = AGENT_WRITE_TOOLS.filter((t) => allowWrite || t.name === AGENT_TOOL_NAMES.runCommand).filter(
		(t) => !limits?.disallowedTools?.includes(t.name)
	);
	return [...workspace, ...coordination, ...ownTools];
}

export async function selectModel(
	hint: string | undefined,
	chatModel: vscode.LanguageModelChat | undefined
): Promise<vscode.LanguageModelChat | undefined> {
	const config = vscode.workspace.getConfiguration();
	const configured = (config.get<string>("customcopilot.subagent.model", "") || "").trim();
	const wanted = (hint ?? "").trim().toLowerCase();
	// Default: the EXACT model object of the caller (main chat or parent
	// agent) — keeps its config (idx/configId), like VS Code runSubagent.
	if (!wanted && chatModel) {
		return chatModel;
	}
	const all = await vscode.lm.selectChatModels();
	if (all.length === 0) {
		return undefined;
	}
	const ours = all.filter((m) => OWN_VENDORS.has(m.vendor));
	// Exact id first: several configs of one model (e.g. five glm-5.3 with
	// different settings) share the name and differ only in their
	// "provider:idx:id::configId" identifier.
	const byText = (needle: string) =>
		all.find((m) => m.id.toLowerCase() === needle) ??
		[...ours, ...all].find((m) => m.id.toLowerCase().endsWith(`:${needle}`)) ??
		[...ours, ...all].find((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));

	if (wanted && wanted !== "fast" && wanted !== "strong") {
		const m = byText(wanted);
		if (m) {
			return m;
		}
	}
	if (configured) {
		const m = byText(configured.toLowerCase());
		if (m) {
			return m;
		}
	}
	if (wanted === "strong" && chatModel) {
		return chatModel;
	}
	const pool = ours.length > 0 ? ours : all;
	if (wanted === "fast") {
		const fast = pool.find((m) => /flash|mini|haiku|air|turbo|lite|nano|small/i.test(`${m.id} ${m.name}`));
		if (fast) {
			return fast;
		}
	}
	// Largest context window ≈ strongest when nothing else is known.
	return [...pool].sort((a, b) => b.maxInputTokens - a.maxInputTokens)[0];
}

