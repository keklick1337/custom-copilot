/**
 * Remote skill-catalog access with an on-disk cache.
 *
 * Sources (all verified live):
 *  - skills.sh — public search index at https://skills.sh/api/search?q=…
 *    (JSON: {skills: [{id: "owner/repo/skillId", name, installs, source:
 *    "owner/repo"}]}). An EMPTY query returns 0 skills — always search with
 *    a term. SKILL.md content is NOT served by skills.sh; it lives in the
 *    source GitHub repo and is resolved by fetchSkillContent().
 *  - hermes-agent — the official GitHub repo (NousResearch/hermes-agent);
 *    skills live at ANY depth under `skills/` and `optional-skills/`
 *    (verified: 209 SKILL.md files, 1–3 nested directories), listed via
 *    the git-trees API.
 *
 * The cache lives under `<globalStorage>/skills-cache/` with a TTL, so
 * browsing/searching works offline and does not hammer the sources.
 */

import * as path from "path";
import * as vscode from "vscode";
import { proxyFetch } from "../network";
import { sanitizeSkillName } from "./skillFile";

export interface CatalogSkill {
	/** Unique id within the source ("skills.sh/<owner>/<repo>/<skill>" / "hermes/<path>"). */
	id: string;
	source: "skills.sh" | "hermes";
	name: string;
	description: string;
	/** Install count (skills.sh results only). */
	installs?: number;
	/** GitHub owner/repo the skill lives in (skills.sh results). */
	repo?: string;
	/** Path of SKILL.md inside the repo, resolved lazily. */
	repoPath?: string;
	/** Direct URL to fetch SKILL.md content from (hermes skills carry it). */
	fetchUrl?: string;
	/** Preloaded SKILL.md content, when the listing already carried it. */
	content?: string;
}

export interface CatalogResult {
	skills: CatalogSkill[];
	fromCache: boolean;
	fetchedAt: number;
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h

function cacheDir(context: vscode.ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, "skills-cache");
}

async function readCache(context: vscode.ExtensionContext, key: string): Promise<CatalogResult | undefined> {
	try {
		const uri = vscode.Uri.file(path.join(cacheDir(context), `${key}.json`));
		const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		const parsed = JSON.parse(raw) as CatalogResult;
		if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) {
			return parsed;
		}
	} catch {
		// no cache / corrupt — treat as a miss
	}
	return undefined;
}

async function writeCache(context: vscode.ExtensionContext, key: string, result: CatalogResult): Promise<void> {
	try {
		const dir = vscode.Uri.file(cacheDir(context));
		await vscode.workspace.fs.createDirectory(dir);
		const uri = vscode.Uri.file(path.join(cacheDir(context), `${key}.json`));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(result)));
	} catch {
		// cache write failures are non-fatal
	}
}

/** Case-insensitive substring + token matching used for client-side filtering. */
export function skillMatchesQuery(skill: CatalogSkill, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) {
		return true;
	}
	const hay = `${skill.name} ${skill.description}`.toLowerCase();
	return q.split(/\s+/).every((token) => hay.includes(token));
}

// ── GitHub helpers ───────────────────────────────────────────────────────────

const GH_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "keklick-copilot" };

interface GithubTreeItem {
	path: string;
	type: "blob" | "tree";
}

/** Fetch the recursive git tree of a repo's main branch. */
async function ghTree(owner: string, repo: string): Promise<GithubTreeItem[]> {
	const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
	try {
		const res = await proxyFetch(url, { headers: GH_HEADERS });
		if (!res.ok) {
			return [];
		}
		const parsed = (await res.json()) as { tree?: GithubTreeItem[] };
		return parsed.tree ?? [];
	} catch {
		return [];
	}
}

/** First SKILL.md path in the repo matching `<anything>/<skillId>/SKILL.md`. */
async function contentPathFor(repo: string, skillId: string): Promise<string | undefined> {
	const [owner, repoName] = repo.split("/");
	if (!owner || !repoName) {
		return undefined;
	}
	const tree = await ghTree(owner, repoName);
	const wanted = `/${skillId}/SKILL.md`;
	const hit = tree.find((t) => t.type === "blob" && t.path.endsWith(wanted));
	return hit?.path;
}

// ── skills.sh ────────────────────────────────────────────────────────────────

interface SkillsShResult {
	id: string;
	skillId?: string;
	name: string;
	installs?: number;
	source: string;
}

export async function fetchSkillsDotSh(query: string): Promise<CatalogSkill[]> {
	const q = query.trim();
	if (!q) {
		return []; // the API returns 0 results for an empty query
	}
	// The only PUBLIC skills.sh endpoint (the /api/v1 registry requires a
	// Vercel OIDC token — server-to-server only). `limit` is documented;
	// an empty query legitimately returns 0 results.
	const url = `https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=100`;
	let raw = "";
	try {
		const res = await proxyFetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) {
			return [];
		}
		raw = await res.text();
	} catch {
		return [];
	}
	const skills: CatalogSkill[] = [];
	try {
		const parsed = JSON.parse(raw) as { skills?: SkillsShResult[] };
		for (const item of parsed.skills ?? []) {
			if (!item?.name || !item.source) {
				continue;
			}
			const installs = typeof item.installs === "number" ? item.installs : undefined;
			skills.push({
				id: `skills.sh/${item.id}`,
				source: "skills.sh",
				name: item.skillId ?? item.name,
				description: item.source,
				installs,
				repo: item.source,
			});
		}
	} catch {
		// malformed JSON — empty result
	}
	return skills;
}

// ── hermes-agent GitHub repo ─────────────────────────────────────────────────

const HERMES_OWNER = "NousResearch";
const HERMES_REPO = "hermes-agent";

/**
 * List hermes-agent skills via the git-trees API (one call, recursive).
 * Skills live at ANY depth under skills/ and optional-skills/.
 */
export async function fetchHermesSkills(): Promise<CatalogSkill[]> {
	const tree = await ghTree(HERMES_OWNER, HERMES_REPO);
	const skills: CatalogSkill[] = [];
	for (const item of tree) {
		if (item.type !== "blob" || !item.path.endsWith("/SKILL.md")) {
			continue;
		}
		const m = /^(?:optional-)?skills\/(.+)\/SKILL\.md$/.exec(item.path);
		if (!m) {
			continue;
		}
		const parts = m[1].split("/");
		const name = parts[parts.length - 1];
		const category = item.path.startsWith("optional-skills/") ? `optional · ${parts[0]}` : parts[0];
		skills.push({
			id: `hermes/${m[1]}`,
			source: "hermes",
			name,
			description: `hermes-agent (${category})`,
			fetchUrl: `https://raw.githubusercontent.com/${HERMES_OWNER}/${HERMES_REPO}/main/${item.path}`,
		});
	}
	return skills;
}

/** Search source selector: skills.sh is the default; hermes is an
 * additional source; "all" queries both. */
export type SkillSource = "skills.sh" | "hermes" | "all";

/** Combined catalog with cache. `forceRefresh` bypasses the TTL. */
export async function fetchCatalog(
	context: vscode.ExtensionContext | undefined,
	query: string,
	forceRefresh = false,
	source: SkillSource = "skills.sh"
): Promise<CatalogResult> {
	const key = `catalog-${source}-${sanitizeSkillName(query.trim() || "all")}`;
	if (context && !forceRefresh) {
		const cached = await readCache(context, key);
		if (cached) {
			return cached;
		}
	}
	let merged: CatalogSkill[] = [];
	if (source === "skills.sh" || source === "all") {
		merged = merged.concat(await fetchSkillsDotSh(query));
	}
	if (source === "hermes" || source === "all") {
		merged = merged.concat((await fetchHermesSkills()).filter((h) => skillMatchesQuery(h, query)));
	}
	const result: CatalogResult = { skills: merged, fromCache: false, fetchedAt: Date.now() };
	if (context) {
		await writeCache(context, key, result);
	}
	return result;
}

/** Fetch a single skill's SKILL.md content. */
export async function fetchSkillContent(skill: CatalogSkill): Promise<string | undefined> {
	if (skill.content) {
		return skill.content;
	}
	// Direct raw URL (hermes skills carry it).
	if (skill.fetchUrl) {
		try {
			const res = await proxyFetch(skill.fetchUrl, { headers: { Accept: "text/plain, */*" } });
			if (res.ok) {
				return await res.text();
			}
		} catch {
			// fall through to repo resolution
		}
	}
	// skills.sh results: resolve the SKILL.md path inside the GitHub repo —
	// convention first (skills/<id>/SKILL.md on main/master), then any depth
	// via the repo's git tree.
	if (skill.repo) {
		const skillId = skill.name;
		const candidates = [
			`https://raw.githubusercontent.com/${skill.repo}/main/skills/${skillId}/SKILL.md`,
			`https://raw.githubusercontent.com/${skill.repo}/master/skills/${skillId}/SKILL.md`,
		];
		for (const url of candidates) {
			try {
				const res = await proxyFetch(url, { headers: { Accept: "text/plain, */*" } });
				if (res.ok) {
					return await res.text();
				}
			} catch {
				// try next
			}
		}
		const repoPath = skill.repoPath ?? (await contentPathFor(skill.repo, skillId));
		if (repoPath) {
			skill.repoPath = repoPath;
			try {
				const res = await proxyFetch(`https://raw.githubusercontent.com/${skill.repo}/main/${repoPath}`, {
					headers: { Accept: "text/plain, */*" },
				});
				if (res.ok) {
					return await res.text();
				}
			} catch {
				// give up
			}
		}
	}
	return undefined;
}

// ── Full-folder download ─────────────────────────────────────────────────────

export interface SkillFolderFile {
	/** Path relative to the skill folder inside the repo. */
	relPath: string;
	content: Buffer;
}

/** Max total bytes downloaded for one skill folder (guards against runaway repos). */
const FOLDER_MAX_BYTES = 5 * 1024 * 1024;
/** Max number of files in one skill folder. */
const FOLDER_MAX_FILES = 60;
/** Extensions we never download (binaries, junk, VCS). */
const FOLDER_DENY_EXT = new Set([
	".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".war",
	".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".png", ".jpg", ".jpeg",
	".gif", ".ico", ".webp", ".pdf", ".woff", ".woff2", ".ttf", ".otf",
	".mp3", ".mp4", ".avi", ".mov", ".lock",
]);
const FOLDER_DENY_NAMES = new Set([".gitignore", ".gitattributes", ".DS_Store"]);

/**
 * Resolve the repo folder path of a skill (the directory containing its
 * SKILL.md) using the repo git tree.
 */
export async function skillRepoFolder(skill: CatalogSkill): Promise<string | undefined> {
	if (!skill.repo) {
		return undefined;
	}
	const repoPath = skill.repoPath ?? (await contentPathFor(skill.repo, skill.name));
	if (!repoPath) {
		return undefined;
	}
	skill.repoPath = repoPath;
	return repoPath.slice(0, repoPath.length - "/SKILL.md".length);
}

/**
 * Download the ENTIRE skill folder (SKILL.md + references/ templates/
 * scripts/ assets/ …) from the source GitHub repo. Returns undefined when
 * the folder cannot be resolved — callers then fall back to SKILL.md-only.
 */
export async function fetchSkillFolder(skill: CatalogSkill): Promise<SkillFolderFile[] | undefined> {
	if (!skill.repo) {
		return undefined;
	}
	const [owner, repoName] = skill.repo.split("/");
	if (!owner || !repoName) {
		return undefined;
	}
	const folder = await skillRepoFolder(skill);
	if (!folder) {
		return undefined;
	}
	const tree = await ghTree(owner, repoName);
	const prefix = `${folder}/`;
	const blobs = tree.filter((t) => t.type === "blob" && t.path.startsWith(prefix));
	let total = 0;
	const files: SkillFolderFile[] = [];
	for (const blob of blobs) {
		const relPath = blob.path.slice(prefix.length);
		if (!relPath || relPath.includes("..")) {
			continue;
		}
		const base = relPath.split("/").pop() ?? relPath;
		const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
		if (FOLDER_DENY_NAMES.has(base) || FOLDER_DENY_EXT.has(ext)) {
			continue;
		}
		if (files.length >= FOLDER_MAX_FILES || total >= FOLDER_MAX_BYTES) {
			break;
		}
		try {
			const res = await proxyFetch(`https://raw.githubusercontent.com/${skill.repo}/main/${blob.path}`, {
				headers: { Accept: "application/octet-stream, text/plain, */*" },
			});
			if (!res.ok) {
				continue;
			}
			const buf = Buffer.from(await res.arrayBuffer());
			total += buf.length;
			if (total > FOLDER_MAX_BYTES) {
				break;
			}
			files.push({ relPath, content: buf });
		} catch {
			// skip files that fail to download
		}
	}
	if (!files.some((f) => f.relPath === "SKILL.md")) {
		// cannot happen when folder was resolved from a SKILL.md path, but guard anyway
		return undefined;
	}
	return files;
}
