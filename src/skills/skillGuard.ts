import * as vscode from "vscode";
import { parseSkillMarkdown, serializeSkillMarkdown } from "./skillFile";
/**
 * Security scanner for skill content — a TypeScript port of hermes-agent's
 * tools/skills_guard.py THREAT_PATTERNS (the subset that applies to SKILL.md
 * instruction packs). Used by the skill tools (install/create/improve) so the
 * agent gets the same verdicts hermes gives: critical/high/medium findings
 * grouped by category, with a scan report the agent must show the user.
 *
 * Ported patterns (regex converted to JS, semantics preserved):
 *  - exfiltration: curl/wget/fetch with interpolated secrets, reading
 *    ~/.ssh|aws|gnupg|kube|docker|hermes .env, cat of secrets files,
 *    env dumps, DNS exfiltration, tmp staging, md image/link exfil
 *  - injection: ignore previous instructions, role hijack, deception,
 *    system-prompt override/leak, conditional deception
 *  - destructive: rm -rf /, curl | sh, mkfs, dd to disk
 */

export interface GuardFinding {
	id: string;
	severity: "critical" | "high" | "medium";
	category: string;
	description: string;
	line: number;
	excerpt: string;
	/** Skill-folder relative path of the scanned file (multi-file scans). */
	file?: string;
}

export interface GuardScanResult {
	findings: GuardFinding[];
	verdict: "clean" | "suspicious" | "dangerous";
}

interface ThreatPattern {
	pattern: RegExp;
	id: string;
	severity: GuardFinding["severity"];
	category: string;
	description: string;
}

const THREAT_PATTERNS: readonly ThreatPattern[] = [
	// ── Exfiltration: shell commands leaking secrets ──
	{
		pattern: /curl\s+(?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b/i,
		id: "env_exfil_curl", severity: "critical", category: "exfiltration",
		description: "curl command interpolating secret environment variable",
	},
	{
		pattern: /wget\s+(?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b/i,
		id: "env_exfil_wget", severity: "critical", category: "exfiltration",
		description: "wget command interpolating secret environment variable",
	},
	// ── Exfiltration: reading credential stores ──
	{ pattern: /\$HOME\/\.ssh|~\/\.ssh/, id: "ssh_dir_access", severity: "high", category: "exfiltration", description: "references user SSH directory" },
	{ pattern: /\$HOME\/\.aws|~\/\.aws/, id: "aws_dir_access", severity: "high", category: "exfiltration", description: "references user AWS credentials directory" },
	{ pattern: /\$HOME\/\.gnupg|~\/\.gnupg/, id: "gpg_dir_access", severity: "high", category: "exfiltration", description: "references user GPG keyring" },
	{ pattern: /\$HOME\/\.kube|~\/\.kube/, id: "kube_dir_access", severity: "high", category: "exfiltration", description: "references Kubernetes config directory" },
	{ pattern: /\$HOME\/\.docker|~\/\.docker/, id: "docker_dir_access", severity: "high", category: "exfiltration", description: "references Docker config (may contain registry creds)" },
	{ pattern: /\$HOME\/\.hermes\/\.env|~\/\.hermes\/\.env/, id: "hermes_env_access", severity: "critical", category: "exfiltration", description: "directly references secrets file" },
	{
		pattern: /cat\s+(?!>)[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/,
		id: "read_secrets_file", severity: "critical", category: "exfiltration",
		description: "reads known secrets file",
	},
	{ pattern: /printenv|env\s*\|/, id: "dump_all_env", severity: "high", category: "exfiltration", description: "dumps all environment variables" },
	{ pattern: /process\.env\[/, id: "node_process_env", severity: "high", category: "exfiltration", description: "accesses process.env (Node.js environment)" },
	{
		pattern: /!\[.*\]\(https?:\/\/[^)]*\$\{?/,
		id: "md_image_exfil", severity: "high", category: "exfiltration",
		description: "markdown image URL with variable interpolation (image-based exfil)",
	},
	{
		pattern: />\s*\/tmp\/[^\s]*\s*&&\s*(curl|wget|nc|python)/,
		id: "tmp_staging", severity: "critical", category: "exfiltration",
		description: "writes to /tmp then exfiltrates",
	},
	// ── Prompt injection ──
	{
		pattern: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i,
		id: "prompt_injection_ignore", severity: "critical", category: "injection",
		description: "prompt injection: ignore previous instructions",
	},
	{
		pattern: /you\s+are\s+(?:\w+\s+)*now\s+/i,
		id: "role_hijack", severity: "high", category: "injection",
		description: "attempts to override the agent's role",
	},
	{
		pattern: /system\s+(?:\w+\s+)*prompt\s+(?:\w+\s+)*override/i,
		id: "sys_prompt_override", severity: "critical", category: "injection",
		description: "attempts to override the system prompt",
	},
	{
		pattern: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i,
		id: "disregard_rules", severity: "critical", category: "injection",
		description: "instructs agent to disregard its rules",
	},
	{
		pattern: /output\s+(?:\w+\s+)*(system|initial)\s+prompt/i,
		id: "leak_system_prompt", severity: "high", category: "injection",
		description: "attempts to extract the system prompt",
	},
	{
		pattern: /(when|if)\s+no\s*one\s+is\s+(watching|looking)/i,
		id: "conditional_deception", severity: "high", category: "injection",
		description: "conditional instruction to behave differently when unobserved",
	},
	// ── Destructive ──
	{ pattern: /rm\s+-rf\s+\/(?!\w)/, id: "rm_rf_root", severity: "critical", category: "destructive", description: "recursive delete targeting filesystem root" },
	{ pattern: /curl[^\n]*\|\s*(ba)?sh/, id: "curl_pipe_sh", severity: "critical", category: "destructive", description: "pipes downloaded content straight into a shell" },
	{ pattern: /mkfs(\.\w+)?\s|dd\s+[^\n]*of=\/dev\/(sd|nvme|hd)/, id: "disk_wipe", severity: "critical", category: "destructive", description: "formats or raw-writes a disk device" },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\};\s*:/, id: "fork_bomb", severity: "critical", category: "destructive", description: "fork bomb" },
];

function verdictFor(findings: readonly GuardFinding[]): GuardScanResult["verdict"] {
	return findings.some((f) => f.severity === "critical" || f.severity === "high")
		? "dangerous"
		: findings.length > 0
			? "suspicious"
			: "clean";
}

/** Scan SKILL.md content (frontmatter description + body) hermes-style. */
export function scanSkillContent(content: string, file?: string): GuardScanResult {
	const findings: GuardFinding[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const t of THREAT_PATTERNS) {
			if (t.pattern.test(line)) {
				findings.push({
					id: t.id,
					severity: t.severity,
					category: t.category,
					description: t.description,
					line: i + 1,
					excerpt: line.trim().slice(0, 200),
					...(file ? { file } : {}),
				});
			}
		}
	}
	// Frontmatter values are decoded by whoever reads the skill (YAML/JSON
	// escapes such as "\u0069gnore"), so scan the DECODED form too —
	// otherwise an escaped payload passes the raw-text scan and is written
	// (or read by Copilot) in clear text.
	const parsed = file === undefined || /(^|\/)SKILL\.md$/i.test(file) ? parseSkillMarkdown(content) : undefined;
	if (parsed) {
		const decoded = serializeSkillMarkdown(parsed.frontmatter, "").split("\n");
		for (let i = 0; i < decoded.length; i++) {
			for (const t of THREAT_PATTERNS) {
				if (t.pattern.test(decoded[i])) {
					findings.push({
						id: t.id,
						severity: t.severity,
						category: t.category,
						description: `${t.description} (decoded frontmatter)`,
						line: i + 1,
						excerpt: decoded[i].trim().slice(0, 200),
						...(file ? { file } : {}),
					});
				}
			}
		}
	}
	// Deduplicate by id+line.
	const seen = new Set<string>();
	const unique = findings.filter((f) => {
		const k = `${f.id}:${f.line}`;
		if (seen.has(k)) {
			return false;
		}
		seen.add(k);
		return true;
	});
	return { findings: unique, verdict: verdictFor(unique) };
}

/** True when the buffer looks binary (NUL byte in the first 8 KiB). */
function looksBinary(buf: Buffer): boolean {
	return buf.subarray(0, 8192).includes(0);
}

/**
 * Scan EVERY file of a skill folder (SKILL.md + references/ scripts/ …).
 * Text files are scanned with the same patterns as SKILL.md; files that
 * cannot be scanned (binary content) are reported as a medium finding so
 * they are never installed silently.
 */
export function scanSkillFiles(files: ReadonlyArray<{ relPath: string; content: Buffer | string }>): GuardScanResult {
	const findings: GuardFinding[] = [];
	for (const f of files) {
		if (typeof f.content !== "string" && looksBinary(f.content)) {
			findings.push({
				id: "unscannable_binary",
				severity: "medium",
				category: "unscannable",
				description: "binary file cannot be scanned — review manually",
				line: 0,
				excerpt: "",
				file: f.relPath,
			});
			continue;
		}
		const text = typeof f.content === "string" ? f.content : f.content.toString("utf8");
		findings.push(...scanSkillContent(text, f.relPath).findings);
	}
	return { findings, verdict: verdictFor(findings) };
}

/** Herme-style report the agent shows the user verbatim on critical/dangerous. */
export function formatScanReport(result: GuardScanResult): string {
	if (!result.findings.length) {
		return "Security scan: clean — no threat patterns found.";
	}
	const order = { critical: 0, high: 1, medium: 2 } as const;
	const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);
	const where = (f: GuardFinding) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : `line ${f.line}`);
	return (
		`Security scan: ${result.verdict.toUpperCase()} — ${sorted.length} finding(s):\n` +
		sorted.map((f) => `[${f.severity.toUpperCase()}] ${f.category}/${f.id} (${where(f)}): ${f.description}${f.excerpt ? `\n    ${f.excerpt}` : ""}`).join("\n")
	);
}

/**
 * Skill safety policy (`customcopilot.skills.safetyScan`, application scope so
 * a cloned workspace can never weaken it):
 * - "block" (default): critical/high findings block the install/save,
 *   others are warnings that need confirmation;
 * - "warn": every finding is only a warning (nothing is blocked);
 * - "off": no security scan at all.
 */
export type SkillSafetyMode = "block" | "warn" | "off";

export function getSkillSafetyMode(): SkillSafetyMode {
	const raw = vscode.workspace.getConfiguration().get<string>("customcopilot.skills.safetyScan", "block");
	return raw === "warn" || raw === "off" ? raw : "block";
}

export async function setSkillSafetyMode(mode: SkillSafetyMode): Promise<void> {
	await vscode.workspace
		.getConfiguration()
		.update("customcopilot.skills.safetyScan", mode, vscode.ConfigurationTarget.Global);
}

const CLEAN_SCAN: GuardScanResult = { findings: [], verdict: "clean" };

/**
 * Run `scan` under the current safety mode and sort its report into
 * `issues` (blocking) or `warnings`. Returns the scan result ("clean" when
 * scanning is off).
 */
export function applySkillSafetyPolicy(
	scan: () => GuardScanResult,
	issues: string[],
	warnings: string[]
): GuardScanResult {
	const mode = getSkillSafetyMode();
	if (mode === "off") {
		return CLEAN_SCAN;
	}
	const result = scan();
	if (result.verdict === "dangerous" && mode === "block") {
		issues.push(formatScanReport(result));
	} else if (result.verdict !== "clean") {
		warnings.push(formatScanReport(result));
	}
	return result;
}

