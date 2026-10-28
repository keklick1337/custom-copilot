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
			frontmatter[match[1]] = parseScalar(match[2].trim());
		}
	}
	if (!frontmatter.name || !frontmatter.description) {
		return undefined;
	}
	return { frontmatter: frontmatter as SkillFrontmatter, body };
}

/** Decode a flat YAML scalar: JSON-style double quotes, single quotes, or plain. */
function parseScalar(raw: string): string {
	if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
		try {
			const v: unknown = JSON.parse(raw);
			if (typeof v === "string") {
				return v;
			}
		} catch {
			// not valid JSON escaping — fall back to stripping the quotes
		}
		return raw.slice(1, -1);
	}
	if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
		return raw.slice(1, -1).replace(/''/g, "'");
	}
	return raw;
}

/**
 * Encode a frontmatter value. Anything that could be misread as YAML
 * structure (":", "#", newlines, leading indicators / quotes, surrounding
 * whitespace) is emitted as a double-quoted JSON string, which is also a
 * valid YAML double-quoted scalar (escapes quotes, backslashes, newlines).
 */
function serializeScalar(value: string): string {
	const needsQuote =
		value === "" ||
		/[:#\n\r\t"\\\u2028\u2029\u0085]/.test(value) ||
		/^[\s'"`[\]{}>|*&!%@,?-]/.test(value) ||
		/\s$/.test(value);
	// JSON.stringify leaves U+2028/U+2029/U+0085 raw; they are line breaks to
	// YAML and to the line-based parser, so escape them explicitly.
	return needsQuote
		? JSON.stringify(value).replace(/[\u2028\u2029\u0085]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
		: value;
}

/** Serialize frontmatter + body back into SKILL.md format. */
export function serializeSkillMarkdown(frontmatter: SkillFrontmatter, body: string): string {
	const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${serializeScalar(String(v ?? ""))}`);
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
