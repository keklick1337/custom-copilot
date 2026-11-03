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

/** Per-agent execution context for shell commands. */
export interface CommandContext {
	agentLabel: string;
	/** Skip confirmations (Autopilot / global auto-approve / setting). */
	autoApprove: boolean;
	/** The user chose "Run all from this agent". */
	allowAll: { value: boolean };
	/** Reported while waiting for approval (shown in the agent tree / status bar). */
	onWaiting: (waiting: string | undefined) => void;
	token: vscode.CancellationToken;
}

const agentTerminals = new Map<string, vscode.Terminal>();

/** Close the terminal of an agent (when it is pruned / on dispose). */
export function disposeAgentTerminal(agentLabel: string): void {
	agentTerminals.get(agentLabel)?.dispose();
	agentTerminals.delete(agentLabel);
}

/**
 * Ask for approval with a NON-modal notification (it does not block the
 * editor; it waits in the notification center if dismissed from view).
 */
async function confirmCommand(command: string, cwd: string, ctx: CommandContext): Promise<boolean> {
	if (ctx.autoApprove || ctx.allowAll.value) {
		return true;
	}
	ctx.onWaiting(command);
	try {
		const short = command.length > 160 ? `${command.slice(0, 157)}…` : command;
		const choice = await Promise.race([
			vscode.window.showInformationMessage(
				`Background agent ${ctx.agentLabel} wants to run: ${short}  (in ${vscode.workspace.asRelativePath(cwd) || cwd})`,
				"Run",
				"Run all from this agent",
				"Deny"
			),
			new Promise<undefined>((resolve) => ctx.token.onCancellationRequested(() => resolve(undefined))),
		]);
		if (choice === "Run all from this agent") {
			ctx.allowAll.value = true;
			return true;
		}
		return choice === "Run";
	} finally {
		ctx.onWaiting(undefined);
	}
}

/**
 * Run a command in the agent's own VS Code terminal ("Agent a7 · name") via
 * shell integration, so the user sees what agents execute. Returns
 * undefined when shell integration is unavailable (caller falls back).
 */
async function runInAgentTerminal(
	command: string,
	cwd: string,
	timeoutMs: number,
	ctx: CommandContext
): Promise<string | undefined> {
	let terminal = agentTerminals.get(ctx.agentLabel);
	if (!terminal || terminal.exitStatus !== undefined) {
		terminal = vscode.window.createTerminal({ name: `Agent ${ctx.agentLabel}`, cwd, isTransient: true });
		agentTerminals.set(ctx.agentLabel, terminal);
	}
	const term = terminal;
	const integration =
		term.shellIntegration ??
		(await new Promise<vscode.TerminalShellIntegration | undefined>((resolve) => {
			const timer = setTimeout(() => {
				sub.dispose();
				resolve(undefined);
			}, 5000);
			const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
				if (e.terminal === term) {
					clearTimeout(timer);
					sub.dispose();
					resolve(e.shellIntegration);
				}
			});
		}));
	if (!integration) {
		return undefined;
	}
	const full = `cd ${JSON.stringify(cwd)} && ${command}`;
	const execution = integration.executeCommand(full);
	let out = "";
	const reading = (async () => {
		for await (const chunk of execution.read()) {
			if (out.length < MAX_OUTPUT_CHARS * 2) {
				out += chunk;
			}
		}
	})();
	let killedBy = "";
	const exitCode = await new Promise<number | undefined>((resolve) => {
		const timer = setTimeout(() => {
			killedBy = `timed out after ${timeoutMs / 1000}s`;
			term.sendText("\u0003", false);
			finish(undefined);
		}, timeoutMs);
		const cancelSub = ctx.token.onCancellationRequested(() => {
			killedBy = "cancelled";
			term.sendText("\u0003", false);
			finish(undefined);
		});
		const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
			if (e.execution === execution) {
				finish(e.exitCode);
			}
		});
		function finish(code: number | undefined) {
			clearTimeout(timer);
			cancelSub.dispose();
			endSub.dispose();
			resolve(code);
		}
	});
	await Promise.race([reading, new Promise((r) => setTimeout(r, 500))]);
	// Strip terminal escape sequences from the captured output.
	// eslint-disable-next-line no-control-regex
	const clean = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "").replace(/\r/g, "");
	return formatResult(clean, exitCode ?? null, killedBy);
}

function formatResult(out: string, code: number | null, killedBy: string, error?: Error): string {
	const trimmed =
		out.length > MAX_OUTPUT_CHARS
			? `${out.slice(0, MAX_OUTPUT_CHARS / 2)}\n…[${out.length - MAX_OUTPUT_CHARS} chars omitted]…\n${out.slice(-MAX_OUTPUT_CHARS / 2)}`
			: out;
	return `${error ? `Failed to start: ${error.message}\n` : ""}${killedBy ? `Process ${killedBy}.\n` : ""}Exit code: ${code ?? "none"}\n${trimmed || "(no output)"}`;
}

/**
 * Run a shell command for an agent: approval (skipped in Autopilot / with
 * auto-approve), then execution in the agent's terminal (falls back to a
 * hidden child process when shell integration is unavailable or disabled).
 */
export async function agentRunCommand(input: Record<string, unknown>, ctx: CommandContext): Promise<string> {
	const command = String(input.command ?? "").trim();
	if (!command) {
		return "Error: `command` is required.";
	}
	const folders = vscode.workspace.workspaceFolders ?? [];
	const cwd = input.cwd ? resolveWorkspacePath(String(input.cwd)).fsPath : folders[0]?.uri.fsPath;
	if (!cwd) {
		return "Error: no workspace folder is open.";
	}
	if (!(await confirmCommand(command, cwd, ctx))) {
		return ctx.token.isCancellationRequested ? "Cancelled." : "The user denied this command.";
	}
	const timeoutMs = Math.min(900, Math.max(1, Number(input.timeoutSeconds ?? 120))) * 1000;
	const useTerminal = vscode.workspace.getConfiguration().get<boolean>("customcopilot.subagent.commandsInTerminal", true);
	if (useTerminal) {
		const viaTerminal = await runInAgentTerminal(command, cwd, timeoutMs, ctx);
		if (viaTerminal !== undefined) {
			return viaTerminal;
		}
	}
	return runInChildProcess(command, cwd, timeoutMs, ctx.token);
}

function runInChildProcess(command: string, cwd: string, timeoutMs: number, token: vscode.CancellationToken): Promise<string> {
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
			resolve(formatResult(out, code, killedBy, error));
		};
		child.on("error", (err) => finish(null, err));
		child.on("close", (code) => finish(code));
	});
}
