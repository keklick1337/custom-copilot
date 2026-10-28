/**
 * Skills screen message handling for the settings webview. All messages are
 * `skills.*`; the controller in configView delegates here so the main file
 * stays focused on provider/model configuration.
 */

import * as vscode from "vscode";
import {
	fetchCatalog,
	type SkillSource,
	fetchSkillBundle,
	type CatalogSkill,
	type SkillFolderFile,
} from "../skills/skillCatalog";
import {
	deleteSkill,
	findLocalSkillByDir,
	findLocalSkillByFile,
	listLocalSkills,
	openSkillInEditor,
	readSkill,
	skillExists,
	updateSkillFile,
	writeSkill,
	writeSkillFolder,
} from "../skills/localSkills";
import { isValidSkillName, parseSkillMarkdown, sanitizeSkillName, serializeSkillMarkdown } from "../skills/skillFile";
import {
	applySkillSafetyPolicy,
	getSkillSafetyMode,
	scanSkillContent,
	scanSkillFiles,
	setSkillSafetyMode,
	type GuardScanResult,
	type SkillSafetyMode,
} from "../skills/skillGuard";
import { proxyFetch } from "../network";

export interface SkillValidation {
	ok: boolean;
	issues: string[];
	warnings: string[];
	/** Overall status for the preview badge: "critical" blocks install,
	 * "warning" is usable but flagged, "ok" is clean. */
	status: "ok" | "warning" | "critical";
	sizeChars: number;
	lineCount: number;
	/** Hermes-style threat-scan verdict over everything that will be written. */
	scanVerdict: GuardScanResult["verdict"];
}

/**
 * Validate a parsed skill before install/save. Issues block the write;
 * warnings are surfaced but do not.
 *
 * The threat scan (skillGuard) runs over `scanTarget`: the full folder when
 * one will be installed (every text file), otherwise the exact SKILL.md that
 * will be written. A "dangerous" verdict (critical/high findings) is an
 * issue and blocks; "suspicious" is a warning.
 */
function validateSkill(
	name: string,
	description: string,
	body: string,
	scanTarget?: { content?: string; files?: SkillFolderFile[] }
): SkillValidation {
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
	const scan = applySkillSafetyPolicy(
		() =>
			scanTarget?.files
				? scanSkillFiles(scanTarget.files)
				: scanSkillContent(
						scanTarget?.content ?? serializeSkillMarkdown({ name: sanitizeSkillName(name), description }, body)
					),
		issues,
		warnings
	);
	const status: "ok" | "warning" | "critical" = issues.length > 0 ? "critical" : warnings.length > 0 ? "warning" : "ok";
	return {
		ok: issues.length === 0,
		issues,
		warnings,
		status,
		sizeChars: body.length,
		lineCount: body ? body.split("\n").length : 0,
		scanVerdict: scan.verdict,
	};
}

/**
 * Non-blocking scan findings (suspicious, or dangerous in "warn" mode) are
 * never installed silently: ask with a modal, like the delete confirmation.
 * Returns true to proceed.
 */
async function confirmSuspicious(name: string, validation: SkillValidation): Promise<boolean> {
	if (validation.scanVerdict === "clean" || !validation.ok) {
		return true;
	}
	const pick = await vscode.window.showWarningMessage(
		`Skill "${name}" has security-scan warnings. Install anyway?`,
		{ modal: true, detail: validation.warnings.join("\n\n") },
		"Install Anyway"
	);
	return pick === "Install Anyway";
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
			case "skills.getSafety": {
				await webview.postMessage({ type: "skills.safety", mode: getSkillSafetyMode() });
				break;
			}
			case "skills.setSafety": {
				const requested = String(message.mode ?? "");
				const mode: SkillSafetyMode = requested === "warn" || requested === "off" ? requested : "block";
				if (mode !== "block") {
					// Weakening the scan is a deliberate choice — confirm it.
					const choice = await vscode.window.showWarningMessage(
						mode === "off"
							? "Turn OFF the skill security scan? Skills (and every file in their folders) will be installed without checking for exfiltration, prompt injection or destructive commands."
							: "Switch the skill security scan to warn-only? Dangerous findings will no longer block installs.",
						{ modal: true },
						"Confirm"
					);
					if (choice !== "Confirm") {
						await webview.postMessage({ type: "skills.safety", mode: getSkillSafetyMode() });
						break;
					}
				}
				try {
					await setSkillSafetyMode(mode);
				} finally {
					// Always re-sync the select with the EFFECTIVE mode (a failed
					// update must not leave the UI showing an unapplied value).
					await webview.postMessage({ type: "skills.safety", mode: getSkillSafetyMode() });
				}
				break;
			}
			case "skills.listLocal": {
				const skills = listLocalSkills();
				await webview.postMessage({ type: "skills.localList", skills });
				break;
			}
			case "skills.search": {
				const query = String(message.query ?? "");
				const forceRefresh = message.refresh === true;
				const rawSource = String(message.source ?? "skills.sh");
				const source: SkillSource = rawSource === "hermes" || rawSource === "all" ? rawSource : "skills.sh";
				const result = await fetchCatalog(skillsContext, query, forceRefresh, source);
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
				// Same resolved source as install: folder SKILL.md + every file scanned.
				const bundle = await fetchSkillBundle(skill);
				if (!bundle) {
					await webview.postMessage({
						type: "skills.installError",
						id: skill.id,
						error: `Could not fetch SKILL.md for "${skill.name}"${skill.repo ? ` from ${skill.repo}` : ""} — the skill may have moved or the repo is unavailable.`,
					});
					break;
				}
				const content = bundle.content;
				const parsed = parseSkillMarkdown(content);
				const name = sanitizeSkillName(parsed?.frontmatter.name ?? skill.name);
				const description = parsed?.frontmatter.description ?? skill.description ?? "";
				const body = parsed?.body ?? content;
				const validation = validateSkill(name, description, body, { content, files: bundle.files });
				await webview.postMessage({
					type: "skills.previewContent",
					id: skill.id,
					skill,
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
				// ONE resolved source: the scanned SKILL.md/files ARE what gets written.
				const bundle = await fetchSkillBundle(skill);
				if (!bundle) {
					await webview.postMessage({
						type: "skills.installError",
						id: skill.id,
						error: `Could not fetch SKILL.md for "${skill.name}"${skill.repo ? ` from ${skill.repo}` : ""} — the skill may have moved or the repo is unavailable.`,
					});
					break;
				}
				const { content, files: folderFiles } = bundle;
				const parsed = parseSkillMarkdown(content);
				const name = sanitizeSkillName(parsed?.frontmatter.name ?? skill.name);
				const description = parsed?.frontmatter.description ?? skill.description ?? "";
				const body = parsed?.body ?? content;
				const validation = validateSkill(name, description, body, { content, files: folderFiles });
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.installError", id: skill.id, error: `Install blocked: ${validation.issues.join(" ")}` });
					break;
				}
				if (!overwrite && skillExists(name)) {
					// Ask the user instead of silently clobbering.
					await webview.postMessage({ type: "skills.alreadyInstalled", id: skill.id, name });
					break;
				}
				if (!(await confirmSuspicious(name, validation))) {
					await webview.postMessage({ type: "skills.installError", id: skill.id, error: "Install cancelled." });
					break;
				}
				const frontmatter = parsed?.frontmatter ?? { name, description };
				// Full-folder install when possible (SKILL.md + references/ etc.);
				// falls back to the single SKILL.md write.
				let dir: string;
				if (folderFiles && folderFiles.length > 1) {
					dir = await writeSkillFolder(name, folderFiles);
				} else {
					dir = await writeSkill(name, frontmatter, body);
				}
				await webview.postMessage({ type: "skills.installed", id: skill.id, name, dir, fileCount: folderFiles?.length ?? 1 });
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
				const validation = validateSkill(name, parsed.frontmatter.description ?? "", parsed.body, {
					content: serializeSkillMarkdown(parsed.frontmatter, parsed.body),
				});
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.error", error: `Import blocked: ${validation.issues.join(" ")}` });
					break;
				}
				if (!message.overwrite && skillExists(name)) {
					await webview.postMessage({ type: "skills.alreadyInstalled", id: `url:${url}`, name });
					break;
				}
				if (!(await confirmSuspicious(name, validation))) {
					await webview.postMessage({ type: "skills.error", error: "Import cancelled." });
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
				const validation = validateSkill(name, parsed.frontmatter.description ?? "", parsed.body, {
					content: serializeSkillMarkdown(parsed.frontmatter, parsed.body),
				});
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.error", error: `Import blocked: ${validation.issues.join(" ")}` });
					break;
				}
				if (skillExists(name)) {
					await webview.postMessage({ type: "skills.alreadyInstalled", id: `file:${uris[0]}`, name });
					break;
				}
				if (!(await confirmSuspicious(name, validation))) {
					await webview.postMessage({ type: "skills.error", error: "Import cancelled." });
					break;
				}
				const dir = await writeSkill(name, parsed.frontmatter, parsed.body);
				await webview.postMessage({ type: "skills.installed", id: `file:${uris[0]}`, name, dir });
				break;
			}
			case "skills.read": {
				const dirPath = String(message.dirPath ?? "");
				// Only real local skill folders may be read (no arbitrary paths).
				const local = findLocalSkillByDir(dirPath);
				if (dirPath && !local) {
					await webview.postMessage({ type: "skills.error", error: "Not a local skill folder." });
					break;
				}
				const parsed = local ? readSkill(local.dirPath) : undefined;
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
				// Updating requires an existing local skill folder — never an
				// arbitrary path supplied by the webview.
				const local = dirPath ? findLocalSkillByDir(dirPath) : undefined;
				if (dirPath && !local) {
					await webview.postMessage({ type: "skills.error", error: "Not a local skill folder — refusing to write." });
					break;
				}
				const validation = validateSkill(name, description, body);
				if (!validation.ok) {
					await webview.postMessage({ type: "skills.error", error: `Save blocked: ${validation.issues.join(" ")}` });
					break;
				}
				// Non-blocking findings (suspicious, or anything in "warn" mode)
				// still need an explicit OK — same contract as install.
				if (!(await confirmSuspicious(name, validation))) {
					await webview.postMessage({ type: "skills.error", error: "Save cancelled." });
					break;
				}
				// Write exactly what was scanned: the SANITIZED name.
				const frontmatter = { name: sanitizeSkillName(name), description };
				if (!local) {
					await writeSkill(name, frontmatter, body);
				} else {
					await updateSkillFile(local.dirPath, frontmatter, body);
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
					// Only delete folders that are actual scanned local skills.
					const target = findLocalSkillByDir(dirPath);
					if (!target) {
						await webview.postMessage({ type: "skills.error", error: "Not a local skill folder — refusing to delete." });
						break;
					}
					const pick = await vscode.window.showWarningMessage(
						`Delete skill "${target.name}"? This removes the folder permanently.`,
						{ modal: true, detail: target.dirPath },
						"Delete"
					);
					if (pick !== "Delete") {
						break;
					}
					await deleteSkill(target.dirPath);
				}
				await webview.postMessage({ type: "skills.deleted", dirPath });
				break;
			}
			case "skills.openInEditor": {
				const fileName = String(message.fileName ?? "");
				if (fileName) {
					const target = findLocalSkillByFile(fileName);
					if (!target) {
						await webview.postMessage({ type: "skills.error", error: "Not a local skill file." });
						break;
					}
					await openSkillInEditor(target.fileName);
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
