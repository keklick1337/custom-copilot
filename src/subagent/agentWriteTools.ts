import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";

/**
 * Write tools for write-enabled subagents (`allowWrite`). Copilot's own edit
 * and terminal tools cannot be driven from another extension (they need
 * Copilot's prompt context or a live chat request), so agents get these.
 * Paths are confined to the workspace folders; every shell command is
 * confirmed by the user unless they allowed all commands for that agent.
 */

const MAX_OUTPUT_CHARS = 20_000;

/** Resolve a path inside a workspace folder; throws when outside. */
function resolveWorkspacePath(p: string): vscode.Uri {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		throw new Error("No workspace folder is open.");
	}
	const raw = (p ?? "").trim();
	if (!raw) {
		throw new Error("`path` is required.");
	}
	const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(folders[0].uri.fsPath, raw);
	const inside = folders.some((f) => {
		const rel = path.relative(f.uri.fsPath, abs);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	});
	if (!inside) {
		throw new Error(`Refusing to touch a path outside the workspace: ${raw}`);
	}
	return vscode.Uri.file(abs);
}

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let i = haystack.indexOf(needle);
	while (i !== -1) {
		count++;
		i = haystack.indexOf(needle, i + needle.length);
	}
	return count;
}

export async function agentEditFile(input: Record<string, unknown>): Promise<string> {
	const uri = resolveWorkspacePath(String(input.path ?? ""));
	const oldString = String(input.oldString ?? "");
	const newString = String(input.newString ?? "");
	if (!oldString) {
		return "Error: `oldString` must not be empty (use the create-file tool for new files).";
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	const text = doc.getText();
	const count = countOccurrences(text, oldString);
	if (count === 0) {
		return "Error: `oldString` was not found. Read the file again and copy the text exactly (whitespace matters).";
	}
	if (count > 1 && input.replaceAll !== true) {
		return `Error: \`oldString\` occurs ${count} times — include more surrounding lines to make it unique, or set replaceAll.`;
	}
	const edit = new vscode.WorkspaceEdit();
	let from = 0;
	let replaced = 0;
	for (;;) {
		const at = text.indexOf(oldString, from);
		if (at === -1) {
			break;
		}
		edit.replace(uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + oldString.length)), newString);
		replaced++;
		from = at + oldString.length;
		if (input.replaceAll !== true) {
			break;
		}
	}
	if (!(await vscode.workspace.applyEdit(edit))) {
		return "Error: the edit could not be applied.";
	}
	await (await vscode.workspace.openTextDocument(uri)).save();
	return `Edited ${vscode.workspace.asRelativePath(uri)} (${replaced} replacement${replaced > 1 ? "s" : ""}).`;
}

export async function agentCreateFile(input: Record<string, unknown>): Promise<string> {
	const uri = resolveWorkspacePath(String(input.path ?? ""));
	const content = String(input.content ?? "");
	let exists = false;
	try {
		await vscode.workspace.fs.stat(uri);
		exists = true;
	} catch {
		exists = false;
	}
	if (exists && input.overwrite !== true) {
		return "Error: the file already exists — set overwrite to replace it, or use the edit tool.";
	}
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	return `${exists ? "Overwrote" : "Created"} ${vscode.workspace.asRelativePath(uri)} (${content.length} chars).`;
}

/**
 * Run a shell command after the user's confirmation. `allowAll` is the
 * per-agent "allow all commands" state, flipped by the dialog.
 */
export async function agentRunCommand(
	input: Record<string, unknown>,
	agentLabel: string,
	allowAll: { value: boolean },
	token: vscode.CancellationToken
): Promise<string> {
	const command = String(input.command ?? "").trim();
	if (!command) {
		return "Error: `command` is required.";
	}
	const folders = vscode.workspace.workspaceFolders ?? [];
	const cwd = input.cwd ? resolveWorkspacePath(String(input.cwd)).fsPath : folders[0]?.uri.fsPath;
	if (!cwd) {
		return "Error: no workspace folder is open.";
	}
	if (!allowAll.value) {
		const choice = await vscode.window.showWarningMessage(
			`Background agent ${agentLabel} wants to run a command`,
			{ modal: true, detail: `${command}\n\nin ${vscode.workspace.asRelativePath(cwd) || cwd}` },
			"Run",
			"Run all from this agent"
		);
		if (choice === "Run all from this agent") {
			allowAll.value = true;
		} else if (choice !== "Run") {
			return "The user denied this command.";
		}
	}
	const timeoutMs = Math.min(900, Math.max(1, Number(input.timeoutSeconds ?? 120))) * 1000;
	return new Promise<string>((resolve) => {
		const child = spawn(command, { cwd, shell: true, env: process.env });
		let out = "";
		const append = (chunk: Buffer) => {
			if (out.length < MAX_OUTPUT_CHARS * 2) {
				out += chunk.toString("utf8");
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		let killedBy = "";
		const kill = (why: string) => {
			killedBy = why;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
		};
		const timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
		const sub = token.onCancellationRequested(() => kill("cancelled"));
		const finish = (code: number | null, error?: Error) => {
			clearTimeout(timer);
			sub.dispose();
			const trimmed =
				out.length > MAX_OUTPUT_CHARS
					? `${out.slice(0, MAX_OUTPUT_CHARS / 2)}\n…[${out.length - MAX_OUTPUT_CHARS} chars omitted]…\n${out.slice(-MAX_OUTPUT_CHARS / 2)}`
					: out;
			resolve(
				`${error ? `Failed to start: ${error.message}\n` : ""}${killedBy ? `Process ${killedBy}.\n` : ""}Exit code: ${code ?? "none"}\n${trimmed || "(no output)"}`
			);
		};
		child.on("error", (err) => finish(null, err));
		child.on("close", (code) => finish(code));
	});
}
