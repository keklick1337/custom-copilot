import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import { logger } from "../logger";

/**
 * Isolated git worktrees for subagents (`isolation: "worktree"`, Claude Code
 * style): the agent gets its own working copy of the repository on its own
 * branch, so its edits never touch the user's checkout.
 *
 *   <repo>/<customcopilot.subagent.worktreeDir>/agent-<id>-<rand>   branch worktree-agent-<id>-<rand>
 *
 * A worktree without changes is removed (with its branch) when the agent
 * finishes; one with changes is kept and its path/branch are reported. The
 * worktree folder is added to .git/info/exclude (never to a tracked file).
 * While its agent runs, a worktree is `git worktree lock`ed with this
 * process' pid, so cleanups (this or another window) never touch it.
 * Every git call uses execFile with an argument array — no shell strings.
 */

export interface AgentWorktree {
	/** Absolute path of the worktree. */
	path: string;
	branch: string;
	/** Commit the worktree was created from. */
	base: string;
	/** Top level of the main checkout (where `git worktree` / branch commands run). */
	repoRoot: string;
	/**
	 * Top level of the checkout the agent started from (the open workspace
	 * folder's checkout, or a parent agent's worktree): paths under it are
	 * re-rooted into this worktree, and "Apply" writes the changes back to it.
	 */
	checkoutRoot: string;
	/** Agent that created it (children inherit it without owning it). */
	owner: string;
	/** Set once it was removed. */
	removed?: boolean;
}

export interface WorktreeChanges {
	/** Changed / untracked paths (git status --porcelain). */
	files: number;
	/** Commits on the worktree branch since `base`. */
	commits: number;
}

const BRANCH_PREFIX = "worktree-";
const BASE_KEY = "customcopilotBase";
const LOCK_PREFIX = "customcopilot agent";

/** Absolute, OS-native form (git prints forward slashes on Windows). */
function norm(p: string): string {
	return path.resolve(p.trim());
}

function samePath(a: string, b: string): boolean {
	const x = norm(a);
	const y = norm(b);
	return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** True when `p` is `root` or inside it (case-insensitive on Windows). */
function within(root: string, p: string): boolean {
	const rel = path.relative(root, p);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function git(args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
		});
	});
}

async function gitOk(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) {
		throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
	}
	return r.stdout.trim();
}

function worktreeDirSetting(): string {
	const raw = (vscode.workspace.getConfiguration().get<string>("customcopilot.subagent.worktreeDir", ".worktrees") || "").trim();
	if (path.isAbsolute(raw)) {
		return raw;
	}
	const segs = raw.split(/[\\/]+/).filter(Boolean);
	// ".", "..", ".git", "" make no sense (or are dangerous) as a worktree folder.
	if (segs.length === 0 || segs.some((s) => s === "." || s === "..") || segs[0].toLowerCase() === ".git") {
		return ".worktrees";
	}
	return segs.join("/");
}

/** Current branch name (or short commit when detached); undefined outside git. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
	const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, 10_000);
	if (r.code !== 0) {
		return undefined;
	}
	const b = r.stdout.trim();
	if (b !== "HEAD") {
		return b;
	}
	const sha = await git(["rev-parse", "--short", "HEAD"], cwd, 10_000);
	return sha.code === 0 ? `detached at ${sha.stdout.trim()}` : undefined;
}

/** Main checkout top level for a folder inside it (or inside one of its worktrees). */
export async function mainRepoRoot(cwd: string): Promise<string | undefined> {
	const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (common.code !== 0) {
		return undefined;
	}
	const dir = norm(common.stdout);
	if (path.basename(dir) === ".git") {
		return path.dirname(dir);
	}
	// Bare repository or unusual layout: fall back to the folder's own top level.
	return checkoutTop(cwd);
}

/** Top level of the checkout (main or linked worktree) containing `cwd`. */
async function checkoutTop(cwd: string): Promise<string | undefined> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	return top.code === 0 && top.stdout.trim() ? norm(top.stdout) : undefined;
}

/**
 * The worktree folder still is that git worktree. If it vanished and was
 * recreated as a plain folder, git commands there would act on the
 * enclosing repository (the user's checkout and index) — never run them then.
 */
async function isLiveWorktree(wt: AgentWorktree): Promise<boolean> {
	if (wt.removed || !fs.existsSync(wt.path)) {
		return false;
	}
	const top = await checkoutTop(wt.path);
	return !!top && samePath(top, wt.path);
}

function worktreesRoot(repoRoot: string): string {
	const dir = worktreeDirSetting();
	return path.isAbsolute(dir) ? path.join(dir, path.basename(repoRoot)) : path.join(repoRoot, dir);
}

/** Keep the worktree folder out of `git status` without touching tracked files. */
async function excludeWorktreeDir(repoRoot: string): Promise<void> {
	const dir = worktreeDirSetting();
	if (path.isAbsolute(dir)) {
		return;
	}
	const rel = `/${dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/`;
	const common = await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot);
	const file = path.join(common, "info", "exclude");
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		// created below
	}
	if (text.split(/\r?\n/).some((l) => l.trim() === rel)) {
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# customcopilot background agent worktrees\n${rel}\n`);
}

/** Copy git-ignored files listed in `.worktreeinclude` (e.g. .env) into the worktree. */
async function copyWorktreeInclude(from: string, to: string): Promise<string[]> {
	const list = path.join(from, ".worktreeinclude");
	if (!fs.existsSync(list)) {
		return [];
	}
	const r = await git(["ls-files", "--others", "--ignored", `--exclude-from=${list}`], from);
	if (r.code !== 0) {
		return [];
	}
	const copied: string[] = [];
	for (const rel of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 2000)) {
		try {
			const dst = path.join(to, rel);
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.copyFileSync(path.join(from, rel), dst);
			copied.push(rel);
		} catch {
			// unreadable / special file — skip
		}
	}
	return copied;
}

/** Symlink heavy folders (`customcopilot.subagent.worktreeSymlinks`, e.g. node_modules). */
function symlinkDirs(from: string, to: string): void {
	const dirs = vscode.workspace.getConfiguration().get<string[]>("customcopilot.subagent.worktreeSymlinks", []) ?? [];
	for (const d of dirs) {
		const rel = String(d).trim();
		if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
			continue;
		}
		const src = path.join(from, rel);
		const dst = path.join(to, rel);
		try {
			if (fs.existsSync(src) && !fs.existsSync(dst)) {
				fs.mkdirSync(path.dirname(dst), { recursive: true });
				fs.symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
			}
		} catch (err) {
			logger.warn("subagent.worktree.symlink", { dir: rel, error: err instanceof Error ? err.message : String(err) });
		}
	}
}

let queue: Promise<unknown> = Promise.resolve();
/** Serialize git worktree operations (they lock the shared repository). */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = queue.then(fn, fn);
	queue = run.catch(() => undefined);
	return run;
}

/**
 * Create a worktree for agent `agentId`, starting at the HEAD of `fromDir`
 * (the parent's worktree or the workspace folder).
 */
export function createAgentWorktree(agentId: string, fromDir: string): Promise<AgentWorktree> {
	return serialized(async () => {
		const repoRoot = await mainRepoRoot(fromDir);
		const checkoutRoot = await checkoutTop(fromDir);
		if (!repoRoot || !checkoutRoot) {
			throw new Error(`isolation "worktree" needs a git repository, but ${fromDir} is not inside one.`);
		}
		const base = await gitOk(["rev-parse", "HEAD"], checkoutRoot).catch(() => {
			throw new Error("isolation \"worktree\" needs at least one commit (HEAD does not resolve).");
		});
		const name = `agent-${agentId}-${randomBytes(4).toString("hex")}`;
		const branch = `${BRANCH_PREFIX}${name}`;
		const dir = path.join(worktreesRoot(repoRoot), name);
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		await excludeWorktreeDir(repoRoot);
		// -b (not -B): never silently reset an existing branch.
		await gitOk(["worktree", "add", "-b", branch, dir, base], repoRoot);
		await git(["worktree", "lock", "--reason", `${LOCK_PREFIX} ${agentId} pid ${process.pid}`, dir], repoRoot);
		await git(["config", "--local", `branch.${branch}.${BASE_KEY}`, base], repoRoot);
		symlinkDirs(checkoutRoot, dir);
		const copied = await copyWorktreeInclude(checkoutRoot, dir);
		logger.info("subagent.worktree.create", { agent: agentId, path: dir, branch, base: base.slice(0, 12), copied: copied.length });
		return { path: dir, branch, base, repoRoot, checkoutRoot, owner: agentId };
	});
}

/** Lock (agent running) / unlock (agent finished) a worktree against cleanups. */
export async function setWorktreeLock(wt: AgentWorktree, locked: boolean): Promise<void> {
	if (wt.removed) {
		return;
	}
	if (locked) {
		await git(["worktree", "lock", "--reason", `${LOCK_PREFIX} ${wt.owner} pid ${process.pid}`, wt.path], wt.repoRoot);
	} else {
		await git(["worktree", "unlock", wt.path], wt.repoRoot);
	}
}

/** Symlinked folders as `:(exclude)` pathspecs (they are not agent changes). */
function symlinkExcludes(): string[] {
	return (vscode.workspace.getConfiguration().get<string[]>("customcopilot.subagent.worktreeSymlinks", []) ?? [])
		.map((s) => String(s).trim().replace(/\\/g, "/").replace(/\/+$/, ""))
		.filter((s) => s && !s.split("/").includes(".."))
		.map((s) => `:(exclude)${s}`);
}

/** Uncommitted files and new commits in a worktree. */
export async function worktreeChanges(wt: AgentWorktree): Promise<WorktreeChanges | undefined> {
	if (!(await isLiveWorktree(wt))) {
		return undefined;
	}
	const status = await git(["status", "--porcelain", "--untracked-files=all", "--", ".", ...symlinkExcludes()], wt.path);
	// Commits on HEAD and on the branch (the agent may have moved HEAD away).
	const onHead = await git(["rev-list", "--count", `${wt.base}..HEAD`], wt.path);
	const onBranch = await git(["rev-list", "--count", `${wt.base}..refs/heads/${wt.branch}`], wt.path);
	if (status.code !== 0 || onHead.code !== 0) {
		// Unknown state: treat as changed so nothing is deleted by mistake.
		return { files: status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 1, commits: 0 };
	}
	const commits = Math.max(parseInt(onHead.stdout.trim(), 10) || 0, onBranch.code === 0 ? parseInt(onBranch.stdout.trim(), 10) || 0 : 0);
	return { files: status.stdout.split("\n").filter(Boolean).length, commits };
}

/** Remove the worktree and its branch. */
export function removeAgentWorktree(wt: AgentWorktree): Promise<boolean> {
	return serialized(async () => {
		if (wt.removed) {
			return true;
		}
		await git(["worktree", "unlock", wt.path], wt.repoRoot);
		const r = await git(["worktree", "remove", "--force", wt.path], wt.repoRoot);
		if (r.code !== 0 && fs.existsSync(wt.path)) {
			logger.warn("subagent.worktree.remove", { path: wt.path, error: r.stderr.trim() });
			return false;
		}
		await git(["worktree", "prune"], wt.repoRoot);
		await git(["branch", "-D", wt.branch], wt.repoRoot);
		wt.removed = true;
		logger.info("subagent.worktree.removed", { path: wt.path, branch: wt.branch });
		return true;
	});
}

/** One-line description for reports and the UI. */
export function describeChanges(c: WorktreeChanges | undefined): string {
	if (!c) {
		return "no changes";
	}
	const parts = [c.files ? `${c.files} changed file${c.files > 1 ? "s" : ""}` : "", c.commits ? `${c.commits} commit${c.commits > 1 ? "s" : ""}` : ""].filter(Boolean);
	return parts.join(", ") || "no changes";
}

/**
 * Apply everything the agent did in its worktree (commits + uncommitted
 * edits + new files, relative to `base`) to the main checkout as working-tree
 * changes (nothing is committed). Returns a summary or throws.
 */
export async function applyWorktreeToMain(wt: AgentWorktree): Promise<string> {
	if (!(await isLiveWorktree(wt))) {
		throw new Error("The worktree no longer exists.");
	}
	const scope = ["--", ".", ...symlinkExcludes()];
	// New files become visible to `git diff` (intent-to-add, worktree index only).
	await git(["add", "--all", "--intent-to-add", ...scope], wt.path);
	// Fixed output format whatever the user's git config (color, noprefix, external diff).
	const diff = await git(
		["diff", "--binary", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", wt.base, ...scope],
		wt.path
	);
	if (diff.code !== 0) {
		throw new Error(`git diff failed: ${diff.stderr.trim()}`);
	}
	if (!diff.stdout.trim()) {
		return "Nothing to apply — the worktree has no changes.";
	}
	const files = (diff.stdout.match(/^diff --git /gm) ?? []).length;
	const apply = (extra: string[]) =>
		new Promise<void>((resolve, reject) => {
			const child = spawn("git", ["apply", ...extra, "--whitespace=nowarn", "-"], { cwd: wt.checkoutRoot });
			let err = "";
			child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `git apply exited with ${code}`))));
			child.stdin.end(diff.stdout);
		});
	// All or nothing: check first, so a conflict never leaves a half-applied patch.
	try {
		await apply(["--check"]);
	} catch (err) {
		throw new Error(
			`the changes do not apply cleanly to ${wt.checkoutRoot} (files changed there since): ${err instanceof Error ? err.message : String(err)}. ` +
				`Merge the branch ${wt.branch} instead, or review the worktree first.`
		);
	}
	await apply([]);
	return `Applied ${files} file${files > 1 ? "s" : ""} from ${wt.branch} to ${wt.checkoutRoot} (uncommitted — review them in Source Control).`;
}

/** A lock of ours whose process is gone (window closed / crashed). */
function lockIsStale(reason: string): boolean {
	const m = new RegExp(`^${LOCK_PREFIX} \\S+ pid (\\d+)$`).exec(reason.trim());
	if (!m) {
		return false; // someone else's lock — respect it
	}
	const pid = Number(m[1]);
	if (pid === process.pid) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * Remove agent worktrees left behind by a previous window (agents live in
 * memory, so none of them is running) — ONLY those without any change.
 */
export async function cleanupStaleAgentWorktrees(): Promise<number> {
	let removed = 0;
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme !== "file") {
			continue;
		}
		const repoRoot = await mainRepoRoot(folder.uri.fsPath);
		if (!repoRoot) {
			continue;
		}
		const list = await git(["worktree", "list", "--porcelain"], repoRoot);
		if (list.code !== 0) {
			continue;
		}
		const root = worktreesRoot(repoRoot);
		for (const block of list.stdout.split("\n\n")) {
			const rawPath = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
			const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim();
			if (!rawPath || !branch || !branch.startsWith(`${BRANCH_PREFIX}agent-`) || !samePath(path.dirname(rawPath), root)) {
				continue;
			}
			const wtPath = norm(rawPath);
			// Locked by a live agent (this window or another one): never touch it.
			const lock = /^locked(?: (.*))?$/m.exec(block);
			if (lock && !lockIsStale(lock[1] ?? "")) {
				continue;
			}
			const base = (await git(["config", "--local", `branch.${branch}.${BASE_KEY}`], repoRoot)).stdout.trim();
			if (!base) {
				continue;
			}
			const wt: AgentWorktree = { path: wtPath, branch, base, repoRoot, checkoutRoot: repoRoot, owner: "" };
			const changes = await worktreeChanges(wt);
			if (changes && changes.files === 0 && changes.commits === 0 && (await removeAgentWorktree(wt))) {
				removed++;
			}
		}
	}
	if (removed > 0) {
		logger.info("subagent.worktree.cleanup", { removed });
	}
	return removed;
}

/**
 * Map a path into the agent's worktree: paths under the checkout it started
 * from are re-rooted to the worktree; relative paths resolve from the worktree.
 */
export function toWorktreePath(p: string, wt: AgentWorktree): string {
	const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(wt.path, p);
	if (within(wt.path, abs)) {
		return abs;
	}
	if (within(wt.checkoutRoot, abs)) {
		return path.join(wt.path, path.relative(wt.checkoutRoot, abs));
	}
	return abs;
}

/**
 * True when `p` (absolute) lies inside the worktree — also after resolving
 * symlinks (a symlinked node_modules must not become a way out).
 */
export function insideWorktree(p: string, wt: AgentWorktree): boolean {
	if (!within(wt.path, p)) {
		return false;
	}
	let probe = p;
	while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
		probe = path.dirname(probe);
	}
	try {
		return within(fs.realpathSync(wt.path), fs.realpathSync(probe));
	} catch {
		return false;
	}
}
