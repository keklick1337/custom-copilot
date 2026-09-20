/**
 * Local skill management: enumerate, read, write and delete skills in the
 * folders VS Code / Copilot Chat natively scans. Installing a skill is just
 * writing `<folder>/<name>/SKILL.md` — no API contract involved.
 *
 * Monitored folders (mirrors VS Code's DEFAULT_SKILL_SOURCE_FOLDERS):
 *   workspace: .agents/skills, .github/skills, .claude/skills
 *   user:      ~/.agents/skills, ~/.copilot/skills, ~/.claude/skills
 *
 * New skills are installed into ~/.copilot/skills (user-global, always
 * scanned regardless of the open workspace).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { parseSkillMarkdown, sanitizeSkillName, serializeSkillMarkdown, type SkillFrontmatter } from "./skillFile";

export interface LocalSkill {
	/** Absolute folder path containing SKILL.md. */
	dirPath: string;
	/** Human label of where it came from (e.g. "~/.copilot/skills"). */
	origin: string;
	/** workspace | user */
	scope: "workspace" | "user";
	name: string;
	description: string;
	fileName: string;
}

function workspaceSkillRoots(): Array<{ dir: string; origin: string }> {
	const ws = vscode.workspace.workspaceFolders ?? [];
	const out: Array<{ dir: string; origin: string }> = [];
	for (const folder of ws) {
		for (const rel of [".agents/skills", ".github/skills", ".claude/skills"]) {
			out.push({ dir: path.join(folder.uri.fsPath, rel), origin: rel });
		}
	}
	return out;
}

function userSkillRoots(): Array<{ dir: string; origin: string }> {
	const home = os.homedir();
	return [
		{ dir: path.join(home, ".agents", "skills"), origin: "~/.agents/skills" },
		{ dir: path.join(home, ".copilot", "skills"), origin: "~/.copilot/skills" },
		{ dir: path.join(home, ".claude", "skills"), origin: "~/.claude/skills" },
	];
}

/** The folder new skills are installed into. */
export function installRoot(): string {
	return path.join(os.homedir(), ".copilot", "skills");
}

/** Scan all monitored skill folders. Missing folders are skipped silently. */
export function listLocalSkills(): LocalSkill[] {
	const out: LocalSkill[] = [];
	const scan = (roots: Array<{ dir: string; origin: string }>, scope: "workspace" | "user") => {
		for (const root of roots) {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(root.dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) {
					continue;
				}
				const skillPath = path.join(root.dir, entry.name, "SKILL.md");
				try {
					const content = fs.readFileSync(skillPath, "utf8");
					const parsed = parseSkillMarkdown(content);
					out.push({
						dirPath: path.join(root.dir, entry.name),
						origin: root.origin,
						scope,
						name: parsed?.frontmatter.name ?? entry.name,
						description: parsed?.frontmatter.description ?? "",
						fileName: skillPath,
					});
				} catch {
					// no SKILL.md or unreadable — skip this folder
				}
			}
		}
	};
	scan(workspaceSkillRoots(), "workspace");
	scan(userSkillRoots(), "user");
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a local skill by (frontmatter) name across all scanned folders. */
export function findLocalSkillByName(name: string): LocalSkill | undefined {
	const wanted = name.trim().toLowerCase();
	return listLocalSkills().find((s) => s.name.toLowerCase() === wanted);
}

export function readSkill(dirPath: string): { frontmatter: SkillFrontmatter; body: string } | undefined {
	try {
		const content = fs.readFileSync(path.join(dirPath, "SKILL.md"), "utf8");
		return parseSkillMarkdown(content) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Check whether a skill with this name already exists in the install root. */
export function skillExists(name: string): boolean {
	const safe = sanitizeSkillName(name);
	try {
		fs.accessSync(path.join(installRoot(), safe, "SKILL.md"));
		return true;
	} catch {
		return false;
	}
}

/** Write (create or update) a skill under the install root. */
export async function writeSkill(name: string, frontmatter: SkillFrontmatter, body: string): Promise<string> {
	const safe = sanitizeSkillName(name);
	const dir = path.join(installRoot(), safe);
	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.writeFile(path.join(dir, "SKILL.md"), serializeSkillMarkdown(frontmatter, body), "utf8");
	return dir;
}


/** Write an entire skill folder (full install: SKILL.md + references/ etc.). */
export async function writeSkillFolder(
	name: string,
	files: Array<{ relPath: string; content: Buffer }>
): Promise<string> {
	const safe = sanitizeSkillName(name);
	const root = path.join(installRoot(), safe);
	await fs.promises.mkdir(root, { recursive: true });
	for (const f of files) {
		// Path safety: reject traversal and absolute paths.
		const rel = path.posix.normalize(f.relPath).replace(/^\.\/+/, "");
		if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
			throw new Error(`Refusing unsafe skill file path: ${f.relPath}`);
		}
		const target = path.join(root, rel);
		if (!target.startsWith(root + path.sep) && target !== path.join(root, rel)) {
			throw new Error(`Refusing unsafe skill file path: ${f.relPath}`);
		}
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await fs.promises.writeFile(target, f.content);
	}
	return root;
}

/** Overwrite an existing skill file in place (keeps its folder). */
export async function updateSkillFile(dirPath: string, frontmatter: SkillFrontmatter, body: string): Promise<void> {
	await fs.promises.writeFile(path.join(dirPath, "SKILL.md"), serializeSkillMarkdown(frontmatter, body), "utf8");
}

export async function deleteSkill(dirPath: string): Promise<void> {
	await fs.promises.rm(dirPath, { recursive: true, force: true });
}

/** Open the skill file in the editor (VS Code has syntax highlighting for the `skill` language). */
export async function openSkillInEditor(fileName: string): Promise<void> {
	await vscode.window.showTextDocument(vscode.Uri.file(fileName));
}
