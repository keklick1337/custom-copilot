import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "../logger";

/**
 * Agent types (Claude Code style): built-in `general-purpose` / `Explore` /
 * `Plan` plus custom agents defined as Markdown files with YAML frontmatter:
 *
 *   <workspace>/.claude/agents/*.md        (Claude Code project agents)
 *   <workspace>/.github/agents/*.agent.md  (Copilot custom agents)
 *   ~/.claude/agents/*.md                  (Claude Code user agents)
 *
 * Frontmatter keys: name, description, tools, disallowedTools, model,
 * maxTurns, isolation ("worktree"). The Markdown body is the agent's system
 * prompt. Project definitions win over user ones with the same name.
 */

export interface AgentTypeDef {
	/** Name used in `subagentType` (matched case-insensitively). */
	name: string;
	/** When to use it — shown to the main agent. */
	description: string;
	/** Type-specific part of the system prompt. */
	prompt: string;
	/** Never gets file edit/create tools, whatever `allowWrite` says. */
	readOnly: boolean;
	/** Implies write tools (custom agent whose `tools` include edit/write). */
	write?: boolean;
	/** Only these workspace tools (exact VS Code tool names), when given. */
	tools?: string[];
	/** Never these workspace tools (exact names). */
	disallowedTools?: string[];
	/** Model hint ("inherit" / empty = the caller's model). */
	model?: string;
	/** Default round budget. */
	maxSteps?: number;
	/** Run in an isolated git worktree by default. */
	isolation?: "worktree";
	source: "built-in" | "project" | "user";
	file?: string;
}

const GENERAL_PROMPT = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research and implementation tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Read a file directly when you know its path.
- For analysis: start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

const READ_ONLY_RULES = `=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
You are STRICTLY PROHIBITED from:
- Creating, modifying, deleting, moving or copying files (you have no edit tools — attempts fail)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state (mkdir, touch, rm, cp, mv, git add, git commit, git checkout, npm install, pip install, …)
Use your terminal (customcopilot_agent_runCommand) ONLY for read-only commands: ls, find, grep, rg, git status, git log, git diff, git grep, cat, head, tail, wc.`;

const EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

${READ_ONLY_RULES}

Your strengths:
- Rapidly finding files by name patterns
- Searching code and text with regex patterns
- Reading and analyzing file contents

Guidelines:
- Use the workspace search tools (file search, text/grep search, symbol search) for broad lookups; read a file directly when you know its path.
- Adapt your search approach to the thoroughness level the caller asked for ("quick", "medium", "very thorough"; default medium).
- Communicate your final report directly as a regular message — do NOT attempt to create files.

You are meant to be a fast agent that returns output as quickly as possible:
- Be smart about how you search for files and implementations.
- Wherever possible issue several tool calls in one round (parallel searches and reads).

Complete the search request efficiently and report your findings clearly: exact file paths with line numbers.`;

const PLAN_PROMPT = `You are a software architect and planning specialist. Your role is to explore the codebase and design implementation plans.

${READ_ONLY_RULES}

You will be provided with a set of requirements and optionally a perspective on how to approach the design.

## Your Process
1. **Understand Requirements**: focus on the requirements provided and apply your assigned perspective throughout.
2. **Explore Thoroughly**: read any files named in the task; find existing patterns and conventions; understand the current architecture; identify similar features as reference; trace the relevant code paths.
3. **Design Solution**: create an implementation approach; consider trade-offs and architectural decisions; follow existing patterns where appropriate.
4. **Detail the Plan**: step-by-step implementation strategy, dependencies and sequencing, potential challenges.

## Required Output
End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts

REMEMBER: you can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files.`;

export const BUILT_IN_TYPES: AgentTypeDef[] = [
	{
		name: "general-purpose",
		description:
			"General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks (with allowWrite: implementing them). Use it when a search may take several attempts or a task has many steps. Default type.",
		prompt: GENERAL_PROMPT,
		readOnly: false,
		source: "built-in",
	},
	{
		name: "Explore",
		description:
			'Fast read-only agent specialized for exploring codebases: find files by patterns (e.g. "src/components/**/*.tsx"), search code for keywords (e.g. "API endpoints"), or answer questions about the codebase (e.g. "how do API endpoints work?"). Say the desired thoroughness in the task: "quick", "medium" or "very thorough".',
		prompt: EXPLORE_PROMPT,
		readOnly: true,
		source: "built-in",
	},
	{
		name: "Plan",
		description:
			"Read-only software architect agent for designing implementation plans. Returns a step-by-step plan, identifies the critical files and considers architectural trade-offs.",
		prompt: PLAN_PROMPT,
		readOnly: true,
		source: "built-in",
	},
];

// ── Custom agent files ─────────────────────────────────────────────────

/** Minimal YAML-frontmatter reader: scalars, inline lists and "- item" lists. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
	const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) {
		return { data: {}, body: text };
	}
	const data: Record<string, string | string[]> = {};
	let listKey: string | undefined;
	let blockKey: string | undefined;
	const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
	for (const raw of m[1].split(/\r?\n/)) {
		if (blockKey !== undefined) {
			if (/^\s+\S/.test(raw) || raw.trim() === "") {
				data[blockKey] = `${data[blockKey] ? `${data[blockKey]} ` : ""}${raw.trim()}`.trim();
				continue;
			}
			blockKey = undefined;
		}
		const item = /^\s*-\s+(.*)$/.exec(raw);
		if (item && listKey) {
			(data[listKey] as string[]).push(unquote(item[1]));
			continue;
		}
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
		if (!kv) {
			continue;
		}
		const key = kv[1];
		const value = kv[2].trim();
		listKey = undefined;
		if (value === "") {
			data[key] = [];
			listKey = key;
		} else if (value === "|" || value === ">" || value === "|-" || value === ">-") {
			data[key] = "";
			blockKey = key;
		} else if (value.startsWith("[") && value.endsWith("]")) {
			data[key] = value
				.slice(1, -1)
				.split(",")
				.map(unquote)
				.filter(Boolean);
		} else {
			data[key] = unquote(value);
		}
	}
	return { data, body: text.slice(m[0].length) };
}

function asList(v: string | string[] | undefined): string[] | undefined {
	if (v === undefined) {
		return undefined;
	}
	const list = Array.isArray(v) ? v : v.split(",");
	const out = list.map((s) => s.trim()).filter(Boolean);
	return out.length ? out : undefined;
}

/** Claude Code / Copilot tool names that mean "can modify files". */
const WRITE_TOOL_NAME = /^(edit|multiedit|write|notebookedit|editfiles|edit\/.*|createfile|new|applypatch|apply_patch|insert_edit_into_file|replace_string_in_file|create_file|customcopilot_agent_(editfile|createfile))$/i;

function definitionFromFile(file: string, source: "project" | "user"): AgentTypeDef | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const { data, body } = parseFrontmatter(text);
	const base = path.basename(file).replace(/\.agent\.md$|\.md$/i, "");
	const name = String(data.name ?? base).trim() || base;
	const description = String(data.description ?? data["when-to-use"] ?? "").trim() || `Custom agent from ${path.basename(file)}`;
	const tools = asList(data.tools);
	const write = tools?.some((t) => WRITE_TOOL_NAME.test(t)) ?? false;
	const maxTurns = Number(data.maxTurns ?? data["max-turns"]);
	const isolation = String(data.isolation ?? "").trim() === "worktree" ? "worktree" : undefined;
	// Explicit VS Code tool names restrict the workspace tools; Claude Code
	// aliases (Read, Grep, Bash, …) only decide read vs. write access.
	const exact = tools?.filter((t) => vscode.lm.tools.some((x) => x.name === t));
	return {
		name,
		description,
		prompt: body.trim(),
		readOnly: tools !== undefined && !write,
		write,
		tools: exact && exact.length ? exact : undefined,
		disallowedTools: asList(data.disallowedTools ?? data["disallowed-tools"]),
		model: String(data.model ?? "").trim() || undefined,
		maxSteps: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : undefined,
		isolation,
		source,
		file,
	};
}

function readDir(dir: string, pattern: RegExp, source: "project" | "user"): AgentTypeDef[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => pattern.test(n))
		.sort()
		.map((n) => definitionFromFile(path.join(dir, n), source))
		.filter((d): d is AgentTypeDef => !!d);
}

let cache: AgentTypeDef[] | undefined;

/** Built-in + custom agent types (cached; invalidated by the file watcher). */
export function agentTypes(): AgentTypeDef[] {
	if (cache) {
		return cache;
	}
	const found = new Map<string, AgentTypeDef>();
	for (const t of BUILT_IN_TYPES) {
		found.set(t.name.toLowerCase(), t);
	}
	const add = (defs: AgentTypeDef[]) => {
		for (const d of defs) {
			found.set(d.name.toLowerCase(), d);
		}
	};
	add(readDir(path.join(os.homedir(), ".claude", "agents"), /\.md$/i, "user"));
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme !== "file") {
			continue;
		}
		add(readDir(path.join(folder.uri.fsPath, ".github", "agents"), /\.agent\.md$/i, "project"));
		add(readDir(path.join(folder.uri.fsPath, ".claude", "agents"), /\.md$/i, "project"));
	}
	cache = [...found.values()];
	logger.debug("subagent.types", { count: cache.length, custom: cache.filter((t) => t.source !== "built-in").map((t) => t.name) });
	return cache;
}

export function invalidateAgentTypes(): void {
	cache = undefined;
}

/** Resolve `subagentType` (case-insensitive; "" = general-purpose). */
export function resolveAgentType(name: string | undefined): AgentTypeDef | undefined {
	const wanted = (name ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
	if (!wanted || wanted === "default" || wanted === "general" || wanted === "agent") {
		return BUILT_IN_TYPES[0];
	}
	const all = agentTypes();
	return all.find((t) => t.name.toLowerCase() === wanted) ?? all.find((t) => t.name.toLowerCase().replace(/[\s_]+/g, "-") === wanted);
}

/** "- name: description" lines for the main agent. */
export function describeAgentTypes(): string {
	return agentTypes()
		.map((t) => {
			const traits = [
				t.readOnly ? "read-only" : t.write ? "can edit files" : "",
				t.isolation === "worktree" ? "runs in its own worktree" : "",
				t.model && t.model !== "inherit" ? `model: ${t.model}` : "",
				t.source !== "built-in" ? `${t.source} agent` : "",
			].filter(Boolean);
			return `- ${t.name}: ${t.description}${traits.length ? ` (${traits.join(", ")})` : ""}`;
		})
		.join("\n");
}

/** Re-read custom agent definitions when their files change. */
export function watchAgentTypes(): vscode.Disposable {
	const watchers = ["**/.claude/agents/*.md", "**/.github/agents/*.agent.md"].map((g) => vscode.workspace.createFileSystemWatcher(g));
	const subs: vscode.Disposable[] = [];
	for (const w of watchers) {
		subs.push(w.onDidCreate(invalidateAgentTypes), w.onDidChange(invalidateAgentTypes), w.onDidDelete(invalidateAgentTypes), w);
	}
	subs.push(vscode.workspace.onDidChangeWorkspaceFolders(invalidateAgentTypes));
	return vscode.Disposable.from(...subs);
}
