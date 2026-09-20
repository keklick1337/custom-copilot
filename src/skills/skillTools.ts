/**
 * Language-model tools for skill discovery and installation. Lets the agent
 * (Copilot Chat) search global skill catalogs and install skills on its own:
 *   - customcopilot.searchSkills  — side-effect free catalog search
 *   - customcopilot.installSkill  — installs into ~/.copilot/skills; ALWAYS
 *     asks for user confirmation via prepareInvocation. When the fetched
 *     skill validates as CRITICAL (invalid frontmatter/name or dangerous
 *     shell patterns), the confirmation message says so explicitly — a
 *     critical skill can never be installed without a human reading the
 *     warning and pressing Continue.
 *
 * Tool contract per vscode.d.ts: registered via `vscode.lm.registerTool` and
 * declared in package.json → contributes.languageModelTools (name,
 * modelDescription, inputSchema).
 */

import * as vscode from "vscode";
import { fetchCatalog, fetchSkillContent, fetchSkillFolder, type CatalogSkill } from "./skillCatalog";
import { findLocalSkillByName, listLocalSkills, readSkill, skillExists, updateSkillFile, writeSkill, writeSkillFolder } from "./localSkills";
import { parseSkillMarkdown, sanitizeSkillName } from "./skillFile";
import { scanSkillContent, formatScanReport } from "./skillGuard";

export interface SearchSkillsInput {
	query: string;
	source?: "skills.sh" | "hermes" | "all";
	limit?: number;
}

export interface InstallSkillInput {
	query: string;
	name: string;
	source?: "skills.sh" | "hermes" | "all";
}

/** Reuse the GUI's validation severity logic (mirror of skillsController). */
function validateSkillContent(
	content: string,
	fallbackName: string
): { status: "ok" | "warning" | "critical"; issues: string[]; warnings: string[]; name: string; parsed?: ReturnType<typeof parseSkillMarkdown> } {
	const parsed = parseSkillMarkdown(content);
	const name = sanitizeSkillName(parsed?.frontmatter.name ?? fallbackName);
	const issues: string[] = [];
	const warnings: string[] = [];
	if (!parsed) {
		issues.push("Content is not a valid SKILL.md (frontmatter with name+description required).");
	}
	if (!name) {
		issues.push("Skill name could not be normalized.");
	}
	const description = parsed?.frontmatter.description ?? "";
	if (!description.trim()) {
		warnings.push("Description is empty — Copilot uses it to decide when to load the skill.");
	}
	const body = parsed?.body ?? "";
	if (!body.trim()) {
		warnings.push("Body is empty.");
	}
	// Hermes-style threat scan (exfiltration / injection / destructive).
	const scan = scanSkillContent(content);
	if (scan.verdict === "dangerous") {
		issues.push(formatScanReport(scan));
	} else if (scan.verdict === "suspicious") {
		warnings.push(formatScanReport(scan));
	}
	const status = issues.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "ok";
	return { status, issues, warnings, name, parsed };
}

/** Pull the line(s) around dangerous shell patterns for the review package. */
function dangerousExcerpts(body: string): string[] {
	const patterns = [
		/rm\s+-rf\s+\//i,
		/curl[^\n]*\|\s*(ba)?sh/i,
		/eval\([^)]*\bfetch/i,
		/powershell[^\n]*-enc/i,
	];
	const excerpts: string[] = [];
	for (const line of body.split("\n")) {
		if (patterns.some((p) => p.test(line))) {
			excerpts.push(line.trim().slice(0, 300));
			if (excerpts.length >= 5) {
				break;
			}
		}
	}
	return excerpts;
}

function trustScore(s: CatalogSkill, trustedOwners: string[]): number {
	const owner = (s.repo ?? "").split("/")[0].toLowerCase();
	let score = s.installs ?? 0;
	if (trustedOwners.includes(owner)) {
		score += 1_000_000; // first-party owners dominate
	}
	return score;
}

function textResult(text: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

// ── customcopilot.searchSkills ───────────────────────────────────────────────

export class SearchSkillsTool implements vscode.LanguageModelTool<SearchSkillsInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SearchSkillsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const query = (options.input.query ?? "").trim();
		if (!query) {
			return textResult("query is required (skills.sh returns nothing for an empty query).");
		}
		const source = options.input.source ?? "skills.sh";
		const limit = Math.min(Math.max(options.input.limit ?? 10, 1), 50);
		const result = await fetchCatalog(undefined, query, false, source);
		if (!result.skills.length) {
			return textResult(`No skills found for "${query}" in ${source}.`);
		}
		const installed = new Set(listLocalSkills().map((s: { name: string }) => s.name));
		// Trust heuristics surfaced for the agent: install count + known
		// first-party owners rank higher.
		const trustedOwners = ["anthropics", "openai", "github", "vercel-labs", "nousresearch"];
		const ranked = [...result.skills].sort((a, b) => trustScore(b, trustedOwners) - trustScore(a, trustedOwners));
		const top = ranked.slice(0, limit);
		// Fetch the FULL SKILL.md of the top 3 candidates so the calling
		// agent can read and compare them before choosing. Non-fetchable
		// entries degrade to name+description.
		const detailed = await Promise.all(
			top.slice(0, 3).map(async (s) => ({ s, content: await fetchSkillContent(s) }))
		);
		const lines = top.map((s) => {
			const inst = installed.has(s.name) ? " [INSTALLED]" : "";
			const downloads = s.installs !== undefined ? ` (${s.installs.toLocaleString()} installs)` : "";
			const trust = trustedOwners.includes((s.repo ?? "").split("/")[0]) ? " [TRUSTED OWNER]" : "";
			return `- ${s.name}${downloads}${inst}${trust} — ${s.description}${s.repo ? ` [${s.repo}]` : ""}`;
		});
		const details = detailed
			.filter((d) => d.content)
			.map((d) => `===== ${d.s.name} (${d.s.repo ?? d.s.source}) =====\n${(d.content as string).slice(0, 4000)}`)
			.join("\n\n");
		return textResult(
			`Found ${result.skills.length} skills for "${query}" (${source}${result.fromCache ? ", cached" : ""}). Ranked by trust (installs, known first-party owners).\n${lines.join("\n")}\n\n` +
				(details
					? `Full SKILL.md of the top ${detailed.filter((d) => d.content).length} candidates for your analysis — read them, pick the one that matches the user's need, then call installSkill with its exact name:\n\n${details}`
					: "Tip: search in ENGLISH for best results (the catalogs are indexed in English).") +
				"\nGuidance: prefer TRUSTED OWNER / high-install skills; analyze the provided SKILL.md bodies and choose the best match before installing."
		);
	}
}

// ── customcopilot.installSkill ───────────────────────────────────────────────

export class InstallSkillTool implements vscode.LanguageModelTool<InstallSkillInput> {
	/**
	 * Runs BEFORE invoke on every call: fetches + validates the skill so the
	 * confirmation the user sees states the real status. CRITICAL findings
	 * are spelled out in the confirmation body — the user must read them and
	 * press Continue; there is no autopilot path past this gate.
	 */
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<InstallSkillInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const { query, name } = options.input;
		const skill = await this.resolve(query, name, options.input.source);
		if (!skill) {
			return {
				invocationMessage: `Skill "${name}" not found`,
			};
		}
		const content = await fetchSkillContent(skill);
		if (!content) {
			return { invocationMessage: `Could not fetch SKILL.md for "${name}"` };
		}
		const v = validateSkillContent(content, skill.name);
		const already = skillExists(v.name);
		// Always require confirmation for an install (write to disk).
		const findings = [
			...v.issues.map((i) => `CRITICAL: ${i}`),
			...v.warnings.map((w) => `warning: ${w}`),
			already ? "note: a skill with this name is already installed and will be overwritten." : "",
		].filter(Boolean);
		return {
			invocationMessage: `Installing skill "${v.name}"${v.status !== "ok" ? ` (${v.status})` : ""}`,
			confirmationMessages: {
				title: v.status === "critical" ? "Install skill — CRITICAL REVIEW REQUIRED" : "Install skill",
				message:
					(v.status === "critical"
						? `The skill "${v.name}" has CRITICAL issues and can only be installed after manual review:\n`
						: `Install skill "${v.name}" from ${skill.repo ?? skill.source} into ~/.copilot/skills?\n`) +
					(findings.length ? findings.map((f) => `• ${f}`).join("\n") : "No issues found."),
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<InstallSkillInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { query, name } = options.input;
		const skill = await this.resolve(query, name, options.input.source);
		if (!skill) {
			return textResult(`Skill "${name}" not found for query "${query}". Search first with searchSkills.`);
		}
		const content = await fetchSkillContent(skill);
		if (!content) {
			return textResult(`Could not fetch SKILL.md for "${name}" — the skill may have moved.`);
		}
		const v = validateSkillContent(content, skill.name);
		if (v.status === "critical") {
			// CRITICAL skills are NEVER installed by the tool. Instead the
			// agent receives a manual-review package: every critical aspect,
			// the suspicious excerpt(s), and an explicit instruction to show
			// it all to the user and offer an analysis with the current chat
			// model. Installation can only happen afterwards, via a NEW
			// installSkill round after the skill is fixed (e.g. through the
			// Skills screen editor).
			const excerpts = dangerousExcerpts(v.parsed?.body ?? content);
			return textResult(
				`INSTALL BLOCKED — manual review required for skill "${name}".\n\n` +
					`Critical aspects (show ALL of these to the user verbatim):\n` +
					v.issues.map((i) => `• CRITICAL: ${i}`).join("\n") +
					(v.warnings.length ? `\nWarnings:\n${v.warnings.map((w) => `• ${w}`).join("\n")}` : "") +
					(excerpts.length ? `\n\nSuspicious excerpt(s):\n${excerpts.map((e) => "```\n" + e + "\n```").join("\n")}` : "") +
					`\n\nSource: ${skill.repo ?? skill.source}\n` +
					`\nNext steps for you (the agent):\n` +
					`1. Present the critical aspects above to the user — do not summarize them away.\n` +
					`2. Offer to run an analysis of the full skill content with the current model right in this chat (you already have the body below) and give a risk assessment.\n` +
					`3. If the user still wants it, they can fix the skill in the Custom Copilot → Skills editor, or install it manually. This tool will keep refusing until the issues are resolved.\n\n` +
					`Full SKILL.md content for your analysis:\n${content.slice(0, 6000)}`
			);
		}
		const frontmatter = v.parsed?.frontmatter ?? { name: v.name, description: skill.description || v.name };
		// Full-folder install when possible (SKILL.md + references/ etc.);
		// falls back to the single SKILL.md write.
		let dir: string;
		let fileCount = 1;
		const folderFiles = await fetchSkillFolder(skill);
		if (folderFiles && folderFiles.length > 1) {
			dir = await writeSkillFolder(v.name, folderFiles);
			fileCount = folderFiles.length;
		} else {
			dir = await writeSkill(v.name, frontmatter, v.parsed?.body ?? content);
		}
		return textResult(
			`Skill "${v.name}" installed to ${dir} (${fileCount} file${fileCount > 1 ? "s" : ""}, full folder).${v.warnings.length ? ` Warnings: ${v.warnings.join("; ")}` : ""} It is now available to Copilot Chat.`
		);
	}

	private async resolve(
		query: string,
		name: string,
		source?: "skills.sh" | "hermes" | "all"
	): Promise<CatalogSkill | undefined> {
		const result = await fetchCatalog(undefined, (query ?? "").trim() || name, false, source ?? "skills.sh");
		const wanted = sanitizeSkillName(name);
		return (
			result.skills.find((s: CatalogSkill) => sanitizeSkillName(s.name) === wanted) ??
			result.skills.find((s: CatalogSkill) => sanitizeSkillName(s.name).includes(wanted))
		);
	}
}

// ── customcopilot.readSkill / improveSkill / createSkill ─────────────────────

export interface ReadSkillInput {
	name: string;
}

export class ReadSkillTool implements vscode.LanguageModelTool<ReadSkillInput> {
	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReadSkillInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const name = (options.input.name ?? "").trim();
		if (!name) {
			return textResult("name is required.");
		}
		const skill = findLocalSkillByName(name);
		if (!skill) {
			const names = listLocalSkills()
				.slice(0, 60)
				.map((s) => s.name)
				.join(", ");
			return textResult(`Skill "${name}" is not installed. Installed skills: ${names || "(none)"}.`);
		}
		const parsed = readSkill(skill.dirPath);
		if (!parsed) {
			return textResult(`Skill "${skill.name}" has an unparsable SKILL.md at ${skill.dirPath}.`);
		}
		return textResult(
			`Skill "${skill.name}" (${skill.origin}, ${skill.scope}). SKILL.md:\n\n---\nname: ${parsed.frontmatter.name}\ndescription: ${parsed.frontmatter.description}\n---\n\n${parsed.body}`
		);
	}
}

export interface ImproveSkillInput {
	name: string;
	/** Full replacement SKILL.md body (markdown after frontmatter). */
	newBody: string;
	/** Optional replacement description (frontmatter). */
	newDescription?: string;
	/** What changed and why — shown in the user confirmation. */
	summary: string;
}

export class ImproveSkillTool implements vscode.LanguageModelTool<ImproveSkillInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ImproveSkillInput>,
		_token: vscode.CancellationToken
	): vscode.PreparedToolInvocation {
		const { name, summary } = options.input;
		const v = quickValidate(options.input.newBody ?? "", options.input.newDescription ?? "");
		return {
			invocationMessage: `Improving skill "${name}"`,
			confirmationMessages: {
				title: v.status === "critical" ? "Improve skill — CRITICAL REVIEW REQUIRED" : "Improve installed skill",
				message:
					`Rewrite installed skill "${name}":\n• ${summary || "(no summary provided)"}\n` +
					(v.warnings.length ? v.warnings.map((w) => `• warning: ${w}`).join("\n") : "• No issues found in the new content."),
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ImproveSkillInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { name, newBody, newDescription, summary } = options.input;
		const skill = findLocalSkillByName(name);
		if (!skill) {
			return textResult(`Skill "${name}" is not installed — nothing to improve. Use readSkill to list installed skills, or createSkill for a new one.`);
		}
		const parsed = readSkill(skill.dirPath);
		const v = quickValidate(newBody, newDescription ?? parsed?.frontmatter.description ?? "");
		if (v.status === "critical") {
			return textResult(
				`Refused to update "${name}": critical issues:\n${v.issues.map((i) => `- ${i}`).join("\n")}\nShow these to the user; fix the content and retry.`
			);
		}
		const frontmatter = {
			name: parsed?.frontmatter.name ?? skill.name,
			description: newDescription ?? parsed?.frontmatter.description ?? skill.description,
		};
		await updateSkillFile(skill.dirPath, frontmatter, newBody);
		return textResult(
			`Skill "${skill.name}" updated in place (${skill.dirPath}). Change: ${summary || "(none stated)"}. The new version is active in Copilot Chat immediately.`
		);
	}
}

export interface CreateSkillInput {
	name: string;
	description: string;
	/** Full SKILL.md body (markdown). */
	body: string;
}

export class CreateSkillTool implements vscode.LanguageModelTool<CreateSkillInput> {
	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CreateSkillInput>,
		_token: vscode.CancellationToken
	): vscode.PreparedToolInvocation {
		const { name, description } = options.input;
		const v = quickValidate(options.input.body, description);
		const exists = !!findLocalSkillByName(name);
		return {
			invocationMessage: `Creating skill "${name}"`,
			confirmationMessages: {
				title: v.status === "critical" ? "Create skill — CRITICAL REVIEW REQUIRED" : "Create new skill",
				message:
					`Create skill "${name}" in ~/.copilot/skills?\n• ${description || "(no description)"}\n` +
					(exists ? `• note: a skill with this name already exists and will be OVERWRITTEN.\n` : "") +
					(v.warnings.length ? v.warnings.map((w) => `• warning: ${w}`).join("\n") : "• No issues found."),
			},
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CreateSkillInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { name, description, body } = options.input;
		const safe = sanitizeSkillName(name);
		if (!safe) {
			return textResult("A valid skill name (lowercase letters, digits, hyphens) is required.");
		}
		const v = quickValidate(body, description);
		if (v.status === "critical") {
			return textResult(
				`Refused to create "${name}": critical issues:\n${v.issues.map((i) => `- ${i}`).join("\n")}`
			);
		}
		const dir = await writeSkill(safe, { name: safe, description }, body);
		return textResult(`Skill "${safe}" created at ${dir}. It is available to Copilot Chat immediately.`);
	}
}

/** Shared light validation for the self-improve tools. */
function quickValidate(body: string, description: string): { status: "ok" | "warning" | "critical"; issues: string[]; warnings: string[] } {
	const issues: string[] = [];
	const warnings: string[] = [];
	if (!(body ?? "").trim()) {
		warnings.push("Body is empty.");
	}
	if (!(description ?? "").trim()) {
		warnings.push("Description is empty — Copilot uses it to decide when to load the skill.");
	}
	// Hermes-style threat scan (exfiltration / injection / destructive).
	const scan = scanSkillContent(body ?? "");
	if (scan.verdict === "dangerous") {
		issues.push(formatScanReport(scan));
	} else if (scan.verdict === "suspicious") {
		warnings.push(formatScanReport(scan));
	}
	const status = issues.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "ok";
	return { status, issues, warnings };
}
