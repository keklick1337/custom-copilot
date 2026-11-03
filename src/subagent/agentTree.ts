import * as vscode from "vscode";
import { agentManager, contextLabel, MAIN_AGENT, type AgentRecord } from "./agentManager";

/**
 * "Background Agents" tree view (sidebar): agents as a tree of who started
 * whom, with status, context usage and inline Stop / Resume / Details.
 */
export class AgentTreeProvider implements vscode.TreeDataProvider<AgentRecord> {
	private readonly emitter = new vscode.EventEmitter<AgentRecord | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	private timer: NodeJS.Timeout | undefined;

	constructor() {
		// Coalesce bursts of changes (every tool call fires one).
		agentManager.onDidChange(() => {
			if (!this.timer) {
				this.timer = setTimeout(() => {
					this.timer = undefined;
					this.emitter.fire(undefined);
				}, 250);
			}
		});
	}

	getChildren(element?: AgentRecord): AgentRecord[] {
		const parentId = element ? element.id : MAIN_AGENT;
		const all = agentManager.list();
		const known = new Set(all.map((a) => a.id));
		return all.filter(
			(a) => a.parentId === parentId || (!element && a.parentId !== MAIN_AGENT && !known.has(a.parentId))
		);
	}

	getParent(element: AgentRecord): AgentRecord | undefined {
		return element.parentId === MAIN_AGENT ? undefined : agentManager.find(element.parentId)?.record;
	}

	getTreeItem(a: AgentRecord): vscode.TreeItem {
		const hasChildren = agentManager.list().some((x) => x.parentId === a.id);
		const item = new vscode.TreeItem(
			`${a.name}`,
			hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
		);
		item.id = a.id;
		item.description = `${a.id} · ${a.status === "running" ? a.activity : a.status} · ${contextLabel(a)} · ${a.steps}/${a.maxSteps}`;
		item.iconPath =
			a.status === "running"
				? new vscode.ThemeIcon("sync~spin")
				: a.status === "done"
					? new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"))
					: a.status === "stopped"
						? new vscode.ThemeIcon("debug-stop")
						: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${a.name}** \`${a.id}\` — ${a.status}\n\n`);
		md.appendMarkdown(`Model: ${a.modelName} \`${a.modelId}\`\n\n`);
		md.appendMarkdown(
			`${contextLabel(a)}${a.compactions ? ` · compacted ${a.compactions}×` : ""}${a.resumes ? ` · resumed ${a.resumes}×` : ""}\n\n`
		);
		md.appendMarkdown(`Started by: ${a.parentId === MAIN_AGENT ? "main chat" : a.parentId} · ${a.toolCalls} tool calls\n\n`);
		md.appendText(a.task.length > 400 ? `${a.task.slice(0, 397)}…` : a.task);
		item.tooltip = md;
		item.contextValue = a.status === "running" ? "agentRunning" : "agentFinished";
		item.command = { command: "customcopilot.showAgentDetails", title: "Details", arguments: [a.id] };
		return item;
	}
}
