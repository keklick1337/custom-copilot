/**
 * Skill-file utilities: parse and serialize SKILL.md files.
 *
 * A skill is a folder containing a SKILL.md with YAML-ish frontmatter
 * (`---` delimited) carrying at least `name` and `description`, followed by
 * a markdown body. This mirrors what VS Code / Copilot Chat scans in
 * `.agents/skills/`, `.github/skills/`, `.claude/skills/` (workspace) and
 * `~/.agents/skills/`, `~/.copilot/skills/`, `~/.claude/skills/` (user).
 */

export interface SkillFrontmatter {
	name: string;
	description: string;
	[key: string]: string;
}

export interface ParsedSkill {
	frontmatter: SkillFrontmatter;
	body: string;
}

/** Parse simple flat `key: value` frontmatter (no nested YAML). */
export function parseSkillMarkdown(content: string): ParsedSkill | undefined {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return undefined;
	}
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) {
		return undefined;
	}
	const fmText = normalized.slice(4, end);
	const body = normalized.slice(end + 4).replace(/^\n+/, "");
	const frontmatter: Record<string, string> = {};
	for (const line of fmText.split("\n")) {
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
		if (match) {
			frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
		}
	}
	if (!frontmatter.name || !frontmatter.description) {
		return undefined;
	}
	return { frontmatter: frontmatter as SkillFrontmatter, body };
}

/** Serialize frontmatter + body back into SKILL.md format. */
export function serializeSkillMarkdown(frontmatter: SkillFrontmatter, body: string): string {
	const lines = Object.entries(frontmatter)
		.filter(([k]) => k !== "name" || true)
		.map(([k, v]) => `${k}: ${String(v).includes(":") ? JSON.stringify(String(v)) : String(v)}`);
	return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

/** VS Code skill-name rule: lowercase alphanumeric and hyphens. */
export function isValidSkillName(name: string): boolean {
	return /^[a-z0-9-]+$/.test(name);
}

/** Sanitize a candidate name into a valid skill folder/name. */
export function sanitizeSkillName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "skill"
	);
}
