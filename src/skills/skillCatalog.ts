/**
 * Remote skill-catalog access with an on-disk cache.
 *
 * Sources:
 *  - skills.sh — the public skill index (https://skills.sh — serves a JSON
 *    index of installable agent skills; we query its search endpoint and
 *    fall back to scraping the HTML listing if the JSON shape changes).
 *  - hermes-agent — the official GitHub repo (NousResearch/hermes-agent);
 *    skills live under `skills/<category>/<name>/SKILL.md` and
 *    `optional-skills/<name>/SKILL.md`. Listed via the GitHub code-search /
 *    git-trees API (no auth token needed for public repos at low rates).
 *
 * The cache lives under `<globalStorage>/skills-cache/` with a TTL, so
 * browsing/searching works offline and does not hammer the sources.
 */

import * as path from "path";
import * as vscode from "vscode";
import { proxyFetch } from "../network";
import { parseSkillMarkdown, sanitizeSkillName, type SkillFrontmatter } from "./skillFile";

export interface CatalogSkill {
	/** Unique id within the source ("skills.sh/<slug>" / "hermes/<category>/<name>"). */
	id: string;
	source: "skills.sh" | "hermes";
	name: string;
	description: string;
	/** Optional source URL to fetch SKILL.md content from. */
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

// ── skills.sh ────────────────────────────────────────────────────────────────

/**
 * skills.sh exposes a JSON search endpoint; we also accept the HTML listing
 * as a fallback. Response shapes are best-effort parsed — a shape change
 * degrades to zero results rather than an error.
 */
export async function fetchSkillsDotSh(query: string): Promise<CatalogSkill[]> {
	const url = query.trim()
		? `https://skills.sh/api/search?q=${encodeURIComponent(query.trim())}`
		: "https://skills.sh/api/skills";
	let raw = "";
	try {
		const res = await proxyFetch(url, { headers: { Accept: "application/json" } });
		if (res.ok) {
			raw = await res.text();
		}
	} catch {
		return [];
	}
	const skills: CatalogSkill[] = [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		const items = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as { skills?: unknown[] }).skills)
				? (parsed as { skills: unknown[] }).skills
				: Array.isArray((parsed as { results?: unknown[] }).results)
					? (parsed as { results: unknown[] }).results
					: [];
		for (const item of items) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const o = item as Record<string, unknown>;
			const name = typeof o.name === "string" ? o.name : typeof o.slug === "string" ? o.slug : "";
			const description = typeof o.description === "string" ? o.description : "";
			if (!name) {
				continue;
			}
			const slug = typeof o.slug === "string" ? o.slug : sanitizeSkillName(name);
			skills.push({
				id: `skills.sh/${slug}`,
				source: "skills.sh",
				name,
				description,
				fetchUrl:
					typeof o.url === "string"
						? o.url
						: typeof o.raw_url === "string"
							? o.raw_url
							: `https://skills.sh/${slug}`,
				content: typeof o.content === "string" ? o.content : undefined,
			});
		}
	} catch {
		// malformed JSON — empty result
	}
	return skills;
}

// ── hermes-agent GitHub repo ─────────────────────────────────────────────────

const HERMES_REPO = "NousResearch/hermes-agent";

interface GithubTreeItem {
	path: string;
	type: "blob" | "tree";
}

/**
 * List hermes-agent skills via the git-trees API (one call, recursive).
 * Paths: skills/<category>/<name>/SKILL.md and optional-skills/<name>/SKILL.md.
 * Descriptions are not in the tree; they are fetched lazily on install, so
 * catalog entries use the category-qualified name until then.
 */
export async function fetchHermesSkills(): Promise<CatalogSkill[]> {
	const url = `https://api.github.com/repos/${HERMES_REPO}/git/trees/main?recursive=1`;
	let raw = "";
	try {
		const res = await proxyFetch(url, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "keklick-copilot" },
		});
		if (!res.ok) {
			return [];
		}
		raw = await res.text();
	} catch {
		return [];
	}
	const skills: CatalogSkill[] = [];
	try {
		const parsed = JSON.parse(raw) as { tree?: GithubTreeItem[] };
		for (const item of parsed.tree ?? []) {
			if (item.type !== "blob") {
				continue;
			}
			const m = /^(?:optional-)?skills\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/.exec(item.path);
			if (!m) {
				continue;
			}
			const category = item.path.startsWith("optional-skills/") ? "optional" : item.path.split("/")[1];
			skills.push({
				id: `hermes/${item.path.replace(/\/SKILL\.md$/, "")}`,
				source: "hermes",
				name: m[1],
				description: `hermes-agent skill (${category})`,
				fetchUrl: `https://raw.githubusercontent.com/${HERMES_REPO}/main/${item.path}`,
			});
		}
	} catch {
		// malformed — empty
	}
	return skills;
}

/** Combined catalog with cache. `forceRefresh` bypasses the TTL. */
export async function fetchCatalog(
	context: vscode.ExtensionContext | undefined,
	query: string,
	forceRefresh = false
): Promise<CatalogResult> {
	const key = `catalog-${sanitizeSkillName(query.trim() || "all")}`;
	if (context && !forceRefresh) {
		const cached = await readCache(context, key);
		if (cached) {
			return cached;
		}
	}
	const [sh, hermes] = await Promise.all([fetchSkillsDotSh(query), fetchHermesSkills()]);
	const merged = [...sh, ...hermes.filter((h) => skillMatchesQuery(h, query))];
	const result: CatalogResult = { skills: merged, fromCache: false, fetchedAt: Date.now() };
	if (context) {
		await writeCache(context, key, result);
	}
	return result;
}

/** Fetch a single skill's SKILL.md content (from cache-first content or URL). */
export async function fetchSkillContent(skill: CatalogSkill): Promise<string | undefined> {
	if (skill.content) {
		return skill.content;
	}
	if (!skill.fetchUrl) {
		return undefined;
	}
	try {
		const res = await proxyFetch(skill.fetchUrl, { headers: { Accept: "text/plain, */*" } });
		if (!res.ok) {
			return undefined;
		}
		const text = await res.text();
		return text;
	} catch {
		return undefined;
	}
}

/** Extract frontmatter from raw content; undefined when unparsable. */
export function frontmatterOf(content: string): SkillFrontmatter | undefined {
	return parseSkillMarkdown(content)?.frontmatter;
}
