import * as vscode from "vscode";
import * as crypto from "crypto";
import { agentManager, contextLabel, MAIN_AGENT, type AgentRecord } from "./agentManager";

/**
 * "Agent map" (Claude Code style): an editor panel showing every chat that
 * started agents as a root, its agents and their sub-agents as a tree, with
 * live status / duration / tokens. Clicking an agent opens its own details
 * tab (AgentDetailsPanel): status, metrics, task, report and the full work
 * log, with Stop / Message / Resume actions.
 */

/** Shared look of both panels (VS Code theme variables). */
const BASE_CSS = `
:root { --line: var(--vscode-panel-border, #555); --card: var(--vscode-editorWidget-background); --muted: var(--vscode-descriptionForeground); }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; background: #888; display: inline-block; }
.dot.running { background: #3fb950; animation: pulse 1.4s infinite; }
.dot.waiting { background: #d29922; animation: pulse 1.4s infinite; }
.dot.failed { background: #f85149; }
.dot.stopped { background: #d29922; }
@keyframes pulse { 50% { opacity: .35; } }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 5px 12px; border-radius: 3px; cursor: pointer; font-family: inherit; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { opacity: .9; }
.badge { font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); flex: 0 0 auto; }
.box.wt code { font-family: var(--vscode-editor-font-family); font-size: 12px; word-break: break-all; }
.box.wt .actions { margin-top: 8px; }
`;

const SHARED_JS = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0);
const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s"; return Math.floor(m / 60) + "h " + (m % 60) + "m"; };
const dotClass = (a) => a.status === "running" ? (/^waiting for approval/.test(a.activity) ? "waiting" : "running") : a.status;
`;

function page(webview: vscode.Webview, title: string, css: string, body: string, script: string): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style nonce="${nonce}">${BASE_CSS}${css}</style></head>
<body>${body}<script nonce="${nonce}">const vscode = acquireVsCodeApi();${SHARED_JS}${script}</script></body></html>`;
}

function summary(r: AgentRecord) {
	return {
		id: r.id,
		name: r.name,
		status: r.status,
		activity: r.activity,
		parentId: r.parentId,
		session: r.session ?? "",
		depth: r.depth,
		modelName: r.modelName,
		modelId: r.modelId,
		startedAt: r.startedAt,
		endedAt: r.endedAt ?? 0,
		totalTokens: r.totalTokens,
		contextTokens: r.contextTokens,
		maxContextTokens: r.maxContextTokens,
		contextExact: r.contextExact,
		steps: r.steps,
		maxSteps: r.maxSteps,
		toolCalls: r.toolCalls,
		compactions: r.compactions,
		resumes: r.resumes,
		allowWrite: r.allowWrite,
		autoApprove: r.autoApprove === true,
		unread: r.inbox.length,
		agentType: r.agentType,
		worktreePath: r.worktree?.path ?? "",
		worktreeBranch: r.worktree?.branch ?? "",
		worktreeOwn: !!r.worktree && r.worktree.owner === r.id,
		worktreeRemoved: r.worktree?.removed === true,
		worktreeStatus: r.worktreeStatus ?? "",
	};
}

/** Debounced refresh on every agent change. */
function onAgentsChanged(fn: () => void): vscode.Disposable {
	let timer: NodeJS.Timeout | undefined;
	const sub = agentManager.onDidChange(() => {
		if (!timer) {
			timer = setTimeout(() => {
				timer = undefined;
				fn();
			}, 300);
		}
	});
	return {
		dispose: () => {
			sub.dispose();
			if (timer) {
				clearTimeout(timer);
			}
		},
	};
}

/** Stop / message / resume coming from either panel. */
async function runAgentAction(type: string, id: string, text: string): Promise<void> {
	if (type === "stop") {
		agentManager.stop(id, true);
	} else if (type === "message") {
		const result = agentManager.send(MAIN_AGENT, id, text);
		if (result.startsWith("Error") || result.startsWith("Not delivered")) {
			vscode.window.showWarningMessage(result);
		}
	} else if (type === "openWorktree") {
		await vscode.commands.executeCommand("customcopilot.openAgentWorktree", id);
	} else if (type === "applyWorktree") {
		await vscode.commands.executeCommand("customcopilot.applyAgentWorktree", id);
	} else if (type === "removeWorktree") {
		await vscode.commands.executeCommand("customcopilot.removeAgentWorktree", id);
	} else if (type === "resume") {
		const cts = new vscode.CancellationTokenSource();
		const result = await agentManager.resume(MAIN_AGENT, id, text.trim() || "Continue the task.", {
			toolInvocationToken: undefined,
			token: cts.token,
			background: true,
		});
		if (result.startsWith("Error")) {
			vscode.window.showWarningMessage(result);
		}
	}
}

// ── Agent map ─────────────────────────────────────────────────────────────

export class AgentMapPanel {
	private static current: AgentMapPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(): void {
		if (AgentMapPanel.current) {
			AgentMapPanel.current.panel.reveal();
			return;
		}
		AgentMapPanel.current = new AgentMapPanel();
	}

	private constructor() {
		this.panel = vscode.window.createWebviewPanel("customcopilot.agentMap", "Agent map", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		this.panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
		this.panel.webview.html = page(this.panel.webview, "Agent map", MAP_CSS, MAP_BODY, MAP_JS);
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((m: { type?: string; id?: string; text?: string }) => {
				if (m.type === "ready") {
					this.push();
				} else if (m.type === "open" && m.id) {
					AgentDetailsPanel.show(m.id);
				} else if (m.type && m.id) {
					void runAgentAction(m.type, m.id, String(m.text ?? ""));
				}
			}),
			onAgentsChanged(() => this.push())
		);
	}

	private push(): void {
		void this.panel.webview.postMessage({
			type: "state",
			agents: agentManager.list().map(summary),
			sessions: agentManager.sessionInfos(),
		});
	}

	private dispose(): void {
		AgentMapPanel.current = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

const MAP_CSS = `
header { padding: 16px 20px 6px; }
header h1 { margin: 0; font-size: 18px; font-weight: 600; }
header .sub { color: var(--muted); margin-top: 4px; }
#map { overflow: auto; padding: 16px 20px 40px; }
.tree { margin-bottom: 28px; }
.node { display: flex; align-items: center; }
.children { display: flex; flex-direction: column; margin-left: 28px; position: relative; }
.children::before { content: ""; position: absolute; left: -28px; top: 50%; width: 28px; border-top: 1px solid var(--line); }
.children > .node { position: relative; padding: 5px 0 5px 22px; }
.children > .node::before { content: ""; position: absolute; left: 0; top: 50%; width: 22px; border-top: 1px solid var(--line); }
.children > .node::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-left: 1px solid var(--line); }
.children > .node:first-child::after { top: 50%; }
.children > .node:last-child::after { bottom: 50%; }
.children > .node:only-child::after { display: none; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 9px 14px; width: 360px; cursor: pointer; box-sizing: border-box; }
.card:hover { border-color: var(--vscode-focusBorder); }
.card.root { cursor: default; }
.title { display: flex; align-items: center; gap: 8px; font-weight: 600; white-space: nowrap; overflow: hidden; }
.title .t { overflow: hidden; text-overflow: ellipsis; }
.meta { color: var(--muted); margin-top: 3px; padding-left: 17px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.root .meta { padding-left: 17px; }
.empty { color: var(--muted); padding: 30px 0; }
`;

const MAP_BODY = `<header><h1>Agent map</h1><div class="sub" id="sub">No agents yet.</div></header><div id="map"></div>`;

const MAP_JS = `
let state = { agents: [], sessions: [] };
function card(a) {
  const dur = fmtDur((a.endedAt || Date.now()) - a.startedAt);
  const extra = a.status === "running" ? " · " + esc(a.activity) : a.status === "done" ? "" : " · " + a.status;
  return '<div class="card" data-id="' + esc(a.id) + '" title="' + esc(a.id + " · " + a.modelName + " — click for details") + '">' +
    '<div class="title"><span class="dot ' + dotClass(a) + '"></span><span class="t">' + esc(a.name) + "</span>" +
      (a.agentType && a.agentType !== "general-purpose" ? '<span class="badge">' + esc(a.agentType) + "</span>" : "") +
      (a.worktreeOwn && !a.worktreeRemoved ? '<span class="badge" title="' + esc(a.worktreePath) + '">worktree</span>' : "") + "</div>" +
    '<div class="meta">' + dur + " · " + fmtTok(a.totalTokens) + " tokens" + extra + "</div></div>";
}
function subtree(a) {
  const kids = state.agents.filter((x) => x.parentId === a.id);
  return '<div class="node">' + card(a) + (kids.length ? '<div class="children">' + kids.map(subtree).join("") + "</div>" : "") + "</div>";
}
function render() {
  const n = state.agents.length, running = state.agents.filter((a) => a.status === "running").length;
  document.getElementById("sub").textContent = n ? n + " agent" + (n > 1 ? "s" : "") + (running ? " · " + running + " running" : "") + " · click an agent for details" : "No agents yet — they appear here when the chat delegates work (#delegate).";
  const ids = new Set(state.agents.map((a) => a.id));
  const tops = state.agents.filter((a) => a.parentId === "main" || !ids.has(a.parentId));
  const groups = new Map();
  for (const a of tops) { const k = a.session || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  let html = "";
  for (const [k, list] of groups) {
    const s = state.sessions.find((x) => x.session === k);
    const meta = [s && s.modelName, s && s.contextTokens ? fmtTok(s.contextTokens) + " tokens in context" : ""].filter(Boolean).join(" · ") || "main chat";
    html += '<div class="tree"><div class="node"><div class="card root"><div class="title"><span class="dot ' + (list.some((a) => a.status === "running") ? "running" : "") + '"></span><span class="t">' + esc((s && s.title) || "Chat") + '</span></div><div class="meta">' + esc(meta) + "</div></div>" +
      '<div class="children">' + list.map(subtree).join("") + "</div></div></div>";
  }
  const map = document.getElementById("map");
  map.innerHTML = html || '<div class="empty">No agents yet.</div>';
  for (const el of map.querySelectorAll(".card[data-id]")) el.onclick = () => vscode.postMessage({ type: "open", id: el.dataset.id });
}
window.addEventListener("message", (ev) => { if (ev.data.type === "state") { state = ev.data; render(); } });
setInterval(() => { if (state.agents.some((a) => a.status === "running")) render(); }, 1000);
vscode.postMessage({ type: "ready" });
`;

// ── Agent details ─────────────────────────────────────────────────────────

/** One editor tab per agent: header, metrics, actions, task, report, work log. */
export class AgentDetailsPanel {
	private static readonly open = new Map<string, AgentDetailsPanel>();
	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	static show(id: string): void {
		const r = agentManager.find(id)?.record;
		if (!r) {
			vscode.window.showWarningMessage(`No agent "${id}".`);
			return;
		}
		const existing = AgentDetailsPanel.open.get(r.id);
		if (existing) {
			existing.panel.reveal();
			return;
		}
		AgentDetailsPanel.open.set(r.id, new AgentDetailsPanel(r.id, r.name));
	}

	private constructor(
		private readonly id: string,
		name: string
	) {
		// Beside the map when it is open, else in the active group.
		this.panel = vscode.window.createWebviewPanel("customcopilot.agentDetails", `Agent: ${name}`, vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		this.panel.iconPath = new vscode.ThemeIcon("hubot");
		this.panel.webview.html = page(this.panel.webview, `Agent ${id}`, DETAILS_CSS, DETAILS_BODY, DETAILS_JS);
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((m: { type?: string; text?: string; id?: string }) => {
				if (m.type === "ready") {
					this.push();
				} else if (m.type === "open" && m.id) {
					AgentDetailsPanel.show(m.id);
				} else if (m.type === "map") {
					AgentMapPanel.show();
				} else if (m.type) {
					void runAgentAction(m.type, this.id, String(m.text ?? ""));
				}
			}),
			onAgentsChanged(() => this.push())
		);
	}

	private push(): void {
		const r = agentManager.find(this.id)?.record;
		if (!r) {
			return;
		}
		this.panel.title = `Agent: ${r.name}`;
		const parent = r.parentId === MAIN_AGENT ? undefined : agentManager.find(r.parentId)?.record;
		void this.panel.webview.postMessage({
			type: "details",
			agent: {
				...summary(r),
				parentName: parent?.name ?? "",
				children: agentManager
					.list()
					.filter((a) => a.parentId === r.id)
					.map((a) => ({ id: a.id, name: a.name, status: a.status, activity: a.activity })),
				task: r.task,
				expectedOutput: r.expectedOutput ?? "",
				report: r.report ?? "",
				error: r.error ?? "",
				context: contextLabel(r),
				transcript: r.transcript,
			},
		});
	}

	private dispose(): void {
		AgentDetailsPanel.open.delete(this.id);
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

const DETAILS_CSS = `
.page { max-width: 1100px; margin: 0 auto; padding: 18px 24px 40px; }
h1 { font-size: 18px; margin: 0; display: flex; align-items: center; gap: 10px; }
.status { color: var(--muted); margin: 4px 0 14px 19px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; margin-bottom: 14px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
.stat .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.stat .v { margin-top: 3px; font-size: 13px; overflow-wrap: anywhere; }
.bar { height: 4px; background: var(--line); border-radius: 2px; margin-top: 6px; overflow: hidden; }
.bar > div { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; margin: 6px 0 4px; }
textarea { flex: 1 1 360px; min-height: 38px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--line)); padding: 6px 8px; font-family: inherit; border-radius: 3px; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 22px 0 8px; }
pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: var(--vscode-editor-font-family); font-size: 12.5px; line-height: 1.45; }
.box { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
.links a { color: var(--vscode-textLink-foreground); cursor: pointer; margin-right: 12px; }
.entry { border-left: 3px solid var(--line); padding: 4px 0 6px 12px; margin: 8px 0; }
.entry .k { font-size: 11px; color: var(--muted); margin-bottom: 3px; }
.entry.tool { border-color: #58a6ff; } .entry.result { border-color: #6e7681; } .entry.thinking { border-color: #a371f7; }
.entry.text, .entry.report { border-color: #3fb950; } .entry.error { border-color: #f85149; } .entry.inbox, .entry.resume { border-color: #d29922; }
.entry.compact { border-color: #db61a2; } .entry.task { border-color: var(--vscode-focusBorder); }
.entry.collapsed pre { max-height: 160px; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); }
.entry .more { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; }
.filters { display: flex; gap: 10px; color: var(--muted); font-size: 12px; margin-bottom: 4px; flex-wrap: wrap; }
.filters label { cursor: pointer; }
`;

const DETAILS_BODY = `<div class="page" id="root"><div class="status">Loading…</div></div>`;

const DETAILS_JS = `
let d = null;
const hidden = new Set(["thinking"]);
const expanded = new Set();
const LABEL = { task: "Task", thinking: "Thinking", text: "Reply", tool: "Tool call", result: "Result", inbox: "Message received", compact: "Context compacted", report: "Final report", error: "Error", resume: "Resumed" };
function stat(l, v, pct) { return '<div class="stat"><div class="l">' + l + '</div><div class="v">' + v + "</div>" + (pct !== undefined ? '<div class="bar"><div style="width:' + Math.min(100, pct) + '%"></div></div>' : "") + "</div>"; }
function render() {
  if (!d) return;
  const running = d.status === "running";
  const root = document.getElementById("root");
  const typed = (document.getElementById("msg") || {}).value || "";
  const scroll = window.scrollY;
  const ctxPct = d.maxContextTokens ? Math.round(d.contextTokens / d.maxContextTokens * 100) : 0;
  const entries = d.transcript.map((e, i) => ({ e, i })).filter(({ e }) => !hidden.has(e.kind)).map(({ e, i }) => {
    const long = e.text.length > 700 && (e.kind === "result" || e.kind === "thinking" || e.kind === "tool") && !expanded.has(i);
    return '<div class="entry ' + e.kind + (long ? " collapsed" : "") + '" data-i="' + i + '"><div class="k">' + (LABEL[e.kind] || e.kind) + (e.tool ? " · " + esc(e.tool) : "") + " · " + new Date(e.at).toLocaleTimeString() + "</div><pre>" + esc(e.text) + "</pre>" + (long ? '<div class="more">show all</div>' : "") + "</div>";
  }).join("");
  const kinds = ["thinking", "text", "tool", "result", "inbox"];
  root.innerHTML =
    '<h1><span class="dot ' + dotClass(d) + '"></span>' + esc(d.name) + "</h1>" +
    '<div class="status">' + esc(d.id) + " · " + esc(d.status) + (running ? " — " + esc(d.activity) : "") + "</div>" +
    '<div class="grid">' +
      stat("Model", esc(d.modelName) + '<br><span style="color:var(--muted);font-size:11px">' + esc(d.modelId) + "</span>") +
      stat("Duration", fmtDur((d.endedAt || Date.now()) - d.startedAt)) +
      stat("Tokens used", fmtTok(d.totalTokens)) +
      stat("Context", (d.contextExact ? "" : "~") + fmtTok(d.contextTokens) + " / " + fmtTok(d.maxContextTokens) + " (" + ctxPct + "%)", ctxPct) +
      stat("Rounds", d.steps + " / " + d.maxSteps, d.maxSteps ? d.steps / d.maxSteps * 100 : 0) +
      stat("Tool calls", d.toolCalls + (d.compactions ? " · compacted " + d.compactions + "×" : "") + (d.resumes ? " · resumed " + d.resumes + "×" : "")) +
      stat("Type", esc(d.agentType || "general-purpose")) +
      stat("Access", d.allowWrite ? "read/write" + (d.autoApprove ? " · auto-approve" : "") : "read-only + terminal") +
      stat("Started by", d.parentId === "main" ? "main chat" : '<span class="links"><a data-open="' + esc(d.parentId) + '">' + esc(d.parentName || d.parentId) + "</a></span>") +
    "</div>" +
    (d.children.length ? '<div class="links">Sub-agents: ' + d.children.map((c) => '<a data-open="' + esc(c.id) + '"><span class="dot ' + dotClass(c) + '"></span> ' + esc(c.name) + "</a>").join("") + "</div>" : "") +
    '<div class="actions">' +
      '<textarea id="msg" placeholder="' + (running ? "Message to the agent (read at its next round)…" : "Follow-up instruction — resumes the agent with its full context…") + '"></textarea>' +
      '<button class="primary" id="send">' + (running ? "Send message" : "Resume") + "</button>" +
      (running ? '<button id="stop">Stop</button>' : "") +
      '<button id="map">Agent map</button>' +
    "</div>" +
    (d.worktreePath ? "<h3>Worktree</h3><div class=\\"box wt\\"><div><code>" + esc(d.worktreePath) + "</code></div><div class=\\"status\\">branch " + esc(d.worktreeBranch) +
      (d.worktreeOwn ? "" : " · inherited from the agent that started it") +
      (d.worktreeRemoved ? " · removed" : d.worktreeStatus ? " · " + esc(d.worktreeStatus) : running ? " · in use" : "") + "</div>" +
      (d.worktreeOwn && !d.worktreeRemoved ? '<div class="actions"><button data-act="openWorktree">Open in new window</button>' +
        (running ? "" : '<button class="primary" data-act="applyWorktree">Apply to workspace</button><button data-act="removeWorktree">Remove worktree</button>') + "</div>" : "") +
      "</div>" : "") +
    (d.error ? "<h3>Error</h3><div class=\\"box\\"><pre>" + esc(d.error) + "</pre></div>" : "") +
    (d.report ? "<h3>Report</h3><div class=\\"box\\"><pre>" + esc(d.report) + "</pre></div>" : "") +
    "<h3>Task</h3><div class=\\"box\\"><pre>" + esc(d.task) + (d.expectedOutput ? "\\n\\nExpected report: " + esc(d.expectedOutput) : "") + "</pre></div>" +
    "<h3>Work log (" + d.transcript.length + ")</h3>" +
    '<div class="filters">' + kinds.map((k) => '<label><input type="checkbox" data-k="' + k + '"' + (hidden.has(k) ? "" : " checked") + "> " + LABEL[k] + "</label>").join("") + "</div>" +
    (entries || '<div class="status">Nothing yet.</div>');
  const msg = document.getElementById("msg"); msg.value = typed;
  document.getElementById("send").onclick = () => { vscode.postMessage({ type: running ? "message" : "resume", text: msg.value }); msg.value = ""; };
  const stop = document.getElementById("stop"); if (stop) stop.onclick = () => vscode.postMessage({ type: "stop" });
  document.getElementById("map").onclick = () => vscode.postMessage({ type: "map" });
  for (const a of root.querySelectorAll("[data-open]")) a.onclick = () => vscode.postMessage({ type: "open", id: a.dataset.open });
  for (const b of root.querySelectorAll("[data-act]")) b.onclick = () => vscode.postMessage({ type: b.dataset.act });
  for (const c of root.querySelectorAll("[data-k]")) c.onchange = () => { if (c.checked) hidden.delete(c.dataset.k); else hidden.add(c.dataset.k); render(); };
  for (const m of root.querySelectorAll(".more")) m.onclick = () => { expanded.add(Number(m.parentElement.dataset.i)); m.parentElement.classList.remove("collapsed"); m.remove(); };
  window.scrollTo(0, scroll);
}
window.addEventListener("message", (ev) => { if (ev.data.type === "details") { d = ev.data.agent; render(); } });
setInterval(() => { if (d && d.status === "running" && document.activeElement?.id !== "msg") render(); }, 1000);
vscode.postMessage({ type: "ready" });
`;
