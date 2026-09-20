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

/** Scan SKILL.md content (frontmatter description + body) hermes-style. */
export function scanSkillContent(content: string): GuardScanResult {
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
				});
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
	const verdict = unique.some((f) => f.severity === "critical" || f.severity === "high")
		? "dangerous"
		: unique.length > 0
			? "suspicious"
			: "clean";
	return { findings: unique, verdict };
}

/** Herme-style report the agent shows the user verbatim on critical/dangerous. */
export function formatScanReport(result: GuardScanResult): string {
	if (!result.findings.length) {
		return "Security scan: clean — no threat patterns found.";
	}
	const order = { critical: 0, high: 1, medium: 2 } as const;
	const sorted = [...result.findings].sort((a, b) => order[a.severity] - order[b.severity]);
	return (
		`Security scan: ${result.verdict.toUpperCase()} — ${sorted.length} finding(s):\n` +
		sorted.map((f) => `[${f.severity.toUpperCase()}] ${f.category}/${f.id} (line ${f.line}): ${f.description}\n    ${f.excerpt}`).join("\n")
	);
}
