import * as vscode from "vscode";
import { beginMainActivity, endMainActivity } from "../chatActivity";
import { MAIN_AGENT, agentManager, contextLabel, formatNotifications, type DelegateTaskInput } from "./agentManager";

/**
 * Subagent language-model tools (see `agentManager.ts`):
 * - `delegateTask` (#delegate) — start an agent on the MAIN CHAT'S MODEL (like
 *   VS Code's built-in runSubagent) in a fresh context; by default it runs in
 *   the background and the main chat continues immediately;
 * - `listAgents`, `sendAgentMessage`, `waitForAgents`, `stopAgent` — observe,
 *   steer and collect the agents.
 * The subagent gets read-only workspace tools unless allowWrite is set.
 */


/** The model the main chat is using (proposed `chatParticipantAdditions`); undefined when unavailable. */
function mainChatModel(options: object): vscode.LanguageModelChat | undefined {
	try {
		return (options as { model?: vscode.LanguageModelChat }).model;
	} catch {
		// The getter throws when the selected model cannot be resolved.
		return undefined;
	}
}

/** The chat session a tool call came from (proposed `chatParticipantPrivate`). */
function chatSession(options: object): string | undefined {
	const uri = (options as { chatSessionResource?: vscode.Uri }).chatSessionResource;
	return uri ? uri.toString() : undefined;
}

function text(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

/** Wrap a main-chat tool call so it counts as main activity (auto-resume idle detection). */
async function asMainActivity<T>(fn: () => Promise<T>): Promise<T> {
	beginMainActivity();
	try {
		return await fn();
	} finally {
		endMainActivity();
	}
}

export class DelegateTaskTool implements vscode.LanguageModelTool<DelegateTaskInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateTaskInput>
	): Promise<vscode.PreparedToolInvocation> {
		const task = (options.input.task ?? "").trim();
		const label = (options.input.name ?? "").trim();
		const short = task.length > 120 ? `${task.slice(0, 117)}…` : task;
		const bg = options.input.background !== false;
		const base = { invocationMessage: `${bg ? "Starting background agent" : "Subagent"}${label ? ` "${label}"` : ""}: ${short}` };
		if (options.input.allowWrite) {
			return {
				...base,
				confirmationMessages: {
					title: "Allow subagent to modify the workspace?",
					message: new vscode.MarkdownString(
						`The subagent will get **write tools** (edits / terminal) for this task:\n\n> ${short}`
					),
				},
			};
		}
		return base;
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<DelegateTaskInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		return asMainActivity(async () => {
			const session = chatSession(options);
			agentManager.noteActiveSession(session);
			return text(
				await agentManager.delegate(MAIN_AGENT, options.input, mainChatModel(options), {
					toolInvocationToken: options.toolInvocationToken,
					session,
					token,
				})
			);
		});
	}
}

interface ListAgentsInput {
	id?: string;
}

export class ListAgentsTool implements vscode.LanguageModelTool<ListAgentsInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<ListAgentsInput>): Promise<vscode.LanguageModelToolResult> {
		agentManager.noteActiveSession(chatSession(options));
		const id = (options.input.id ?? "").trim();
		if (id) {
			return text(agentManager.details(id) ?? `No agent "${id}".`);
		}
		return text(agentManager.describe(MAIN_AGENT));
	}
}

interface SendAgentMessageInput {
	to: string;
	message: string;
}

export class SendAgentMessageTool implements vscode.LanguageModelTool<SendAgentMessageInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<SendAgentMessageInput>
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Message to agent ${options.input.to}` };
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SendAgentMessageInput>): Promise<vscode.LanguageModelToolResult> {
		agentManager.noteActiveSession(chatSession(options));
		return text(agentManager.send(MAIN_AGENT, options.input.to, options.input.message));
	}
}

interface WaitForAgentsInput {
	ids?: string[];
	timeoutSeconds?: number;
}

export class WaitForAgentsTool implements vscode.LanguageModelTool<WaitForAgentsInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<WaitForAgentsInput>
	): Promise<vscode.PreparedToolInvocation> {
		const t = options.input.timeoutSeconds;
		return { invocationMessage: t === 0 ? "Reading agent updates" : "Waiting for background agents…" };
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<WaitForAgentsInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const session = chatSession(options);
		agentManager.noteActiveSession(session);
		const ids = Array.isArray(options.input.ids) ? options.input.ids.map(String) : undefined;
		const timeoutMs = Math.min(3600, Math.max(0, Number(options.input.timeoutSeconds ?? 600))) * 1000;
		// Blocked waiting counts as an active main turn: no auto-resume message
		// is posted while the main agent is waiting here.
		await asMainActivity(() => agentManager.waitMain(ids, timeoutMs, token, session));
		// Cancelled (user pressed Stop): VS Code discards this result, so the
		// notifications must stay unread (auto-resume / a later wait gets them).
		if (token.isCancellationRequested) {
			return text("Cancelled.");
		}
		// Only this chat session's notifications (+ unscoped ones).
		const pending = agentManager.drainNotifications(session);
		const status = agentManager.describe(MAIN_AGENT);
		if (pending.length === 0) {
			return text(`No new agent notifications.\n\n${status}`);
		}
		return text(`${formatNotifications(pending, 60_000, false)}\n\n## Agents\n${status}`);
	}
}

interface ResumeAgentInput {
	id: string;
	message?: string;
	background?: boolean;
}

export class ResumeAgentTool implements vscode.LanguageModelTool<ResumeAgentInput> {
	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ResumeAgentInput>
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Resuming agent ${options.input.id}` };
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ResumeAgentInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		return asMainActivity(async () => {
			const session = chatSession(options);
			agentManager.noteActiveSession(session);
			return text(
				await agentManager.resume(MAIN_AGENT, options.input.id, options.input.message ?? "", {
					toolInvocationToken: options.toolInvocationToken,
					token,
					background: options.input.background !== false,
					session,
				})
			);
		});
	}
}

/** UI: resume an agent with a message typed by the user. */
export async function resumeAgentFromUi(id: string): Promise<void> {
	const rec = agentManager.find(id)?.record;
	if (!rec) {
		vscode.window.showWarningMessage(`No agent "${id}".`);
		return;
	}
	const message = await vscode.window.showInputBox({
		title: `Resume agent ${rec.id} "${rec.name}"`,
		prompt: "Instruction for the agent (it continues with its previous context)",
		value: "Continue the task.",
		ignoreFocusOut: true,
	});
	if (message === undefined) {
		return;
	}
	const cts = new vscode.CancellationTokenSource();
	const result = await agentManager.resume(MAIN_AGENT, rec.id, message, {
		toolInvocationToken: undefined,
		token: cts.token,
		background: true,
	});
	if (result.startsWith("Error")) {
		vscode.window.showWarningMessage(result);
	}
}

interface StopAgentInput {
	id: string;
}

export class StopAgentTool implements vscode.LanguageModelTool<StopAgentInput> {
	async invoke(options: vscode.LanguageModelToolInvocationOptions<StopAgentInput>): Promise<vscode.LanguageModelToolResult> {
		agentManager.noteActiveSession(chatSession(options));
		const id = (options.input.id ?? "").trim();
		if (id.toLowerCase() === "all") {
			agentManager.stopAll();
			return text("Stopping all running agents.");
		}
		const r = agentManager.stop(id);
		return text(r ? `Stopping agent ${r.id} "${r.name}" (was ${r.status}).` : `No agent "${id}".`);
	}
}

/** Command palette: list agents, open a report or stop an agent. */
export async function showAgentsQuickPick(): Promise<void> {
	const agents = agentManager.tree();
	if (agents.length === 0) {
		vscode.window.showInformationMessage("No background agents.");
		return;
	}
	const picked = await vscode.window.showQuickPick(
		agents.map((a) => ({
			label: `${"\u2003".repeat(a.depth - 1)}${a.status === "running" ? "$(sync~spin)" : a.status === "done" ? "$(check)" : "$(error)"} ${a.id} ${a.name}`,
			description: `${a.status} · ${a.modelName} [${a.modelId}] · ${a.steps} rounds`,
			detail: a.status === "running" ? a.activity : a.task.slice(0, 200),
			id: a.id,
		})),
		{ title: "Background agents", placeHolder: "Select an agent" }
	);
	if (!picked) {
		return;
	}
	const rec = agentManager.find(picked.id)?.record;
	const actions = rec?.status === "running" ? ["Show details", "Stop agent"] : ["Show details", "Resume agent…"];
	const action = await vscode.window.showQuickPick(actions, { title: `${picked.id}` });
	if (action === "Resume agent…") {
		await resumeAgentFromUi(picked.id);
	} else if (action === "Stop agent") {
		agentManager.stop(picked.id, true);
	} else if (action === "Show details") {
		const doc = await vscode.workspace.openTextDocument({ content: agentManager.details(picked.id) ?? "", language: "markdown" });
		await vscode.window.showTextDocument(doc, { preview: true });
	}
}

/** Status-bar hover: one line per agent with Stop / Details command links. */
export function agentsTooltip(): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.isTrusted = {
		enabledCommands: [
			"customcopilot.stopAgentById",
			"customcopilot.resumeAgentById",
			"customcopilot.showAgentDetails",
			"customcopilot.stopAllAgents",
		],
	};
	md.supportThemeIcons = true;
	const agents = agentManager.tree();
	const link = (cmd: string, id: string) => `command:${cmd}?${encodeURIComponent(JSON.stringify([id]))}`;
	md.appendMarkdown("**Background agents**\n\n");
	for (const a of agents) {
		const icon = a.status === "running" ? "$(sync~spin)" : a.status === "done" ? "$(check)" : "$(error)";
		const indent = "&nbsp;&nbsp;&nbsp;&nbsp;".repeat(a.depth - 1);
		const name = a.name.replace(/[[\]*_`]/g, "");
		const action =
			a.status === "running"
				? ` · [$(debug-stop) Stop](${link("customcopilot.stopAgentById", a.id)})`
				: ` · [$(debug-restart) Resume](${link("customcopilot.resumeAgentById", a.id)})`;
		md.appendMarkdown(
			`${indent}${icon} \`${a.id}\` ${name} — ${a.status === "running" ? a.activity : a.status} · ${contextLabel(a)}${action} · [Details](${link("customcopilot.showAgentDetails", a.id)})\n\n`
		);
	}
	const unread = agentManager.unreadNotifications();
	if (unread) {
		md.appendMarkdown(`_${unread} unread report(s)/message(s) for the main agent_\n\n`);
	}
	if (agentManager.runningCount() > 1) {
		md.appendMarkdown(`[$(debug-stop) Stop all](command:customcopilot.stopAllAgents)`);
	}
	return md;
}

/** Open an agent's details (task, status, report) in a read-only document. */
export async function showAgentDetails(id: string): Promise<void> {
	const details = agentManager.details(id);
	if (!details) {
		vscode.window.showWarningMessage(`No agent "${id}".`);
		return;
	}
	const doc = await vscode.workspace.openTextDocument({ content: details, language: "markdown" });
	await vscode.window.showTextDocument(doc, { preview: true });
}

