/**
 * Skills screen message handling for the settings webview. All messages are
 * `skills.*`; the controller in configView delegates here so the main file
 * stays focused on provider/model configuration.
 */

import * as vscode from "vscode";
import {
	fetchCatalog,
	fetchSkillContent,
	type CatalogSkill,
} from "../skills/skillCatalog";
import {
	deleteSkill,
	listLocalSkills,
	openSkillInEditor,
	readSkill,
	skillExists,
	updateSkillFile,
	writeSkill,
} from "../skills/localSkills";
import { isValidSkillName, parseSkillMarkdown, sanitizeSkillName } from "../skills/skillFile";
import { proxyFetch } from "../network";

export interface SkillValidation {
	ok: boolean;
	issues: string[];
	warnings: string[];
}

/**
 * Validate a parsed skill before install/save. Issues block the write;
 * warnings are surfaced but do not.
 */
function validateSkill(name: string, description: string, body: string): SkillValidation {
	const issues: string[] = [];
	const warnings: string[] = [];
	const safe = sanitizeSkillName(name);
	if (!name.trim()) {
		issues.push("Name is required.");
	} else if (!isValidSkillName(safe)) {
		issues.push(`Name "${name}" cannot be normalized to lowercase letters, digits and hyphens.`);
	}
	if (!description.trim()) {
		warnings.push("Description is empty — Copilot uses it to decide when to load the skill.");
	}
	if (!body.trim()) {
		warnings.push("Body is empty — the skill will contain no instructions.");
	}
	if (body.length > 100_000) {
		warnings.push("Body is very large (>100k chars); consider splitting the skill.");
	}
	return { ok: issues.length === 0, issues, warnings };
}

export async function handleSkillsMessage(
	webview: vscode.Webview,
	message: Record<string, unknown>
): Promise<boolean> {
	const type = String(message.type ?? "");
	if (!type.startsWith("skills.")) {
		return false;
	}
	try {
		switch (type) {
			case "skills.listLocal": {
				const skills = listLocalSkills();
				await webview.postMessage({ type: "skills.localList", skills });
				break;
			}
			case "skills.search": {
				const query = String(message.query ?? "");
				const forceRefresh = message.refresh === true;
				const result = await fetchCatalog(skillsContext, query, forceRefresh);
				await webview.postMessage({
					type: "skills.searchResults",
					skills: result.skills.slice(0, 200),
					fromCache: result.fromCache,
					total: result.skills.length,
				});
				break;
			}
			case "skills.filterLocal": {
				const query = String(message.query ?? "");
				const all = listLocalSkills();
				const filtered = all.filter((s) =>
					`${s.name} ${s.description}`.toLowerCase().includes(query.trim().toLowerCase())
				);
				await webview.postMessage({ type: "skills.localList", skills: filtered });
				break;
			}
			case "skills.preview": {
				// Fetch + validate a catalog skill WITHOUT installing it.
				const skill = message.skill as CatalogSkill | undefined;
				if (!skill?.id) {
					break;
				}
				const content = await fetchSkillContent(skill);
				if (!content) {
					await webview.postMessage({ type: "skills.installError", id: skill.id, error: "Could not fetch SKILL.md" });
					break;
				}
				const parsed = parseSkillMarkdown(content);
				const name = sanitizeSkillName(parsed?.frontmatter.name ?? skill.name);
				const description = parsed?.frontmatter.description ?? skill.description ?? "";
				const body = parsed?.body ?? content;
				const validation = validateSkill(name, description, body);
				await webview.postMessage({
					type: "skills.previewContent",
					id: skill.id,
					name,
					description,
					body,
					validation,
					alreadyInstalled: skillExists(name),
				});
				break;
			}
			case "skills.install": {
				const skill = message.skill as CatalogSkill | undefined;
				const overwrite = message.overwrite === true;
				if (!skill?.id) {
					break;
				}
				const content = await fetchSkillContent(skill);
				if (!content) {
					await webview.postMessage({ type: "skills.installError", id: skill.id, error: "Could not fetch SKILL.md" });
					break;
				}
				const parsed = parseSkillMarkdown(content);
				const name = sanitizeSkillName(parsed?.frontmatter.name ?? skill.name);
				const description = parsed?.frontmatter.description ?? skill.description ?? "";
				const body = parsed?.body ?? content;
				const validation = validateSkill(name, description, body);
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.installError", id: skill.id, error: validation.issues.join(" ") });
					break;
				}
				if (!overwrite && skillExists(name)) {
					// Ask the user instead of silently clobbering.
					await webview.postMessage({ type: "skills.alreadyInstalled", id: skill.id, name });
					break;
				}
				const frontmatter = parsed?.frontmatter ?? { name, description };
				const dir = await writeSkill(name, frontmatter, body);
				await webview.postMessage({ type: "skills.installed", id: skill.id, name, dir });
				break;
			}
			case "skills.importUrl": {
				// Import a SKILL.md from any raw URL (e.g. a GitHub link).
				const url = String(message.url ?? "").trim();
				if (!/^https?:\/\//i.test(url)) {
					await webview.postMessage({ type: "skills.error", error: "Enter a valid http(s) URL to a SKILL.md." });
					break;
				}
				let content = "";
				try {
					const res = await proxyFetch(url, { headers: { Accept: "text/plain, */*" } });
					if (!res.ok) {
						throw new Error(`HTTP ${res.status} ${res.statusText}`);
					}
					content = await res.text();
				} catch (err) {
					await webview.postMessage({
						type: "skills.error",
						error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
					});
					break;
				}
				const parsed = parseSkillMarkdown(content);
				if (!parsed) {
					await webview.postMessage({ type: "skills.error", error: "The URL did not contain a valid SKILL.md (frontmatter with name+description required)." });
					break;
				}
				const name = sanitizeSkillName(parsed.frontmatter.name);
				const validation = validateSkill(name, parsed.frontmatter.description ?? "", parsed.body);
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.error", error: validation.issues.join(" ") });
					break;
				}
				if (!message.overwrite && skillExists(name)) {
					await webview.postMessage({ type: "skills.alreadyInstalled", id: `url:${url}`, name });
					break;
				}
				const dir = await writeSkill(name, parsed.frontmatter, parsed.body);
				await webview.postMessage({ type: "skills.installed", id: `url:${url}`, name, dir });
				break;
			}
			case "skills.importFile": {
				// Pick a local SKILL.md (or any markdown file) via the OS dialog.
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: false,
					filters: { "Markdown / Skill": ["md", "markdown", "txt"] },
					title: "Import SKILL.md",
				});
				if (!uris || uris.length === 0) {
					break;
				}
				const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uris[0]));
				const parsed = parseSkillMarkdown(content);
				if (!parsed) {
					await webview.postMessage({ type: "skills.error", error: "The file is not a valid SKILL.md (frontmatter with name+description required)." });
					break;
				}
				const name = sanitizeSkillName(parsed.frontmatter.name);
				const validation = validateSkill(name, parsed.frontmatter.description ?? "", parsed.body);
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.error", error: validation.issues.join(" ") });
					break;
				}
				if (skillExists(name)) {
					await webview.postMessage({ type: "skills.alreadyInstalled", id: `file:${uris[0]}`, name });
					break;
				}
				const dir = await writeSkill(name, parsed.frontmatter, parsed.body);
				await webview.postMessage({ type: "skills.installed", id: `file:${uris[0]}`, name, dir });
				break;
			}
			case "skills.read": {
				const dirPath = String(message.dirPath ?? "");
				const parsed = dirPath ? readSkill(dirPath) : undefined;
				await webview.postMessage({
					type: "skills.content",
					dirPath,
					frontmatter: parsed?.frontmatter ?? null,
					body: parsed?.body ?? "",
				});
				break;
			}
			case "skills.save": {
				const dirPath = String(message.dirPath ?? "");
				const name = String(message.name ?? "");
				const description = String(message.description ?? "");
				const body = String(message.body ?? "");
				const validation = validateSkill(name, description, body);
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.error", error: validation.issues.join(" ") });
					break;
				}
				if (!dirPath) {
					await writeSkill(name, { name: sanitizeSkillName(name), description }, body);
				} else {
					await updateSkillFile(dirPath, { name, description }, body);
				}
				await webview.postMessage({
					type: "skills.saved",
					dirPath,
					warnings: validation.warnings,
				});
				break;
			}
			case "skills.delete": {
				const dirPath = String(message.dirPath ?? "");
				if (dirPath) {
					const local = listLocalSkills();
					const target = local.find((s) => s.dirPath === dirPath);
					const pick = await vscode.window.showWarningMessage(
						`Delete skill "${target?.name ?? dirPath}"? This removes the folder permanently.`,
						{ modal: true },
						"Delete"
					);
					if (pick !== "Delete") {
						break;
					}
					await deleteSkill(dirPath);
				}
				await webview.postMessage({ type: "skills.deleted", dirPath });
				break;
			}
			case "skills.openInEditor": {
				const fileName = String(message.fileName ?? "");
				if (fileName) {
					await openSkillInEditor(fileName);
				}
				break;
			}
			default:
				break;
		}
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		await webview.postMessage({ type: "skills.error", error: errorMessage });
	}
	return true;
}

/** Set by configView when the controller is constructed (has globalStorage etc.). */
let skillsContext: vscode.ExtensionContext | undefined;
export function setSkillsContext(context: vscode.ExtensionContext): void {
	skillsContext = context;
}
