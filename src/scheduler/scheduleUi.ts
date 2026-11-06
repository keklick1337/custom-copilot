import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { beginMainActivity, currentTurnTitle, endMainActivity } from "../chatActivity";
import { agentManager } from "../subagent/agentManager";
import { type ScheduleInput, type ScheduledEvent, formatEvery, formatIn, formatWhen, parseAt, scheduler } from "./scheduler";

/**
 * Everything the user sees of the scheduler: the `#schedule` LM tool (with
 * in-chat controls), the "Scheduled" tree view, the Schedule panel (webview
 * with live countdowns, history and a "new reminder" form), the status-bar
 * clock and the commands behind them.
 */

const CHAT_COMMANDS = ["customcopilot.cancelScheduled", "customcopilot.runScheduledNow", "customcopilot.showSchedule"];

function cmd(command: string, ...args: unknown[]): string {
	return `command:${command}${args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : ""}`;
}

function chatSession(options: object): string | undefined {
	const uri = (options as { chatSessionResource?: vscode.Uri }).chatSessionResource;
	return uri ? uri.toString() : undefined;
}

function sessionTitle(session: string | undefined): string | undefined {
	return session ? agentManager.sessionInfos().find((s) => s.session === session)?.title : undefined;
}

// ── LM tool ────────────────────────────────────────────────────────────

export class ScheduleWakeupTool implements vscode.LanguageModelTool<ScheduleInput> {
	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ScheduleInput>): Promise<vscode.PreparedToolInvocation> {
		const i = options.input;
		const action = i.action ?? (i.id && !i.prompt ? "cancel" : "schedule");
		if (action === "list") {
			return { invocationMessage: "Checking scheduled wake-ups" };
		}
		if (action === "cancel") {
			return { invocationMessage: `Cancelling wake-up ${i.id ?? ""}` };
		}
		const when = i.at ? `at ${i.at}` : i.delaySeconds ? `in ${formatIn(Number(i.delaySeconds) * 1000)}` : i.everySeconds ? formatEvery(Number(i.everySeconds) * 1000) : "";
		return { invocationMessage: `Scheduling a wake-up ${when}${i.reason ? `: ${i.reason}` : ""}` };
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ScheduleInput>): Promise<vscode.LanguageModelToolResult> {
		beginMainActivity();
		try {
			const i = options.input;
			const action = i.action ?? (i.id && !i.prompt ? "cancel" : "schedule");
			const session = chatSession(options);
			agentManager.noteActiveSession(session);
			if (action === "list") {
				return text(scheduler.describe());
			}
			if (action === "cancel") {
				const e = scheduler.cancel(String(i.id ?? ""));
				return text(e ? `Cancelled wake-up ${e.id} (${e.reason}).` : `No pending wake-up "${i.id}".\n\n${scheduler.describe()}`);
			}
			const created = scheduler.create(i, "agent", session, sessionTitle(session) ?? currentTurnTitle());
			if (typeof created === "string") {
				return text(created);
			}
			const result = text(
				`Scheduled wake-up ${created.id} for ${formatWhen(created.dueAt)} (in ${formatIn(created.dueAt - Date.now())})` +
					`${created.everyMs ? `, then ${formatEvery(created.everyMs)}${created.runsLeft !== undefined ? ` (${created.runsLeft} runs)` : " until cancelled"}` : ""}. ` +
					"Its prompt will be posted into this chat as a new message then, and you continue from it. " +
					"If you have nothing else to do now, END YOUR TURN with a one-line status — do not wait, poll or sleep." +
					`\n\nPending:\n${scheduler.describe()}`
			);
			const md = new vscode.MarkdownString(undefined, true);
			md.isTrusted = { enabledCommands: CHAT_COMMANDS };
			md.appendMarkdown(
				`$(clock) Wake-up **${created.id}** at ${formatWhen(created.dueAt)}${created.everyMs ? ` · ${formatEvery(created.everyMs)}` : ""} — ` +
					`[Run now](${cmd("customcopilot.runScheduledNow", created.id)}) · [Cancel](${cmd("customcopilot.cancelScheduled", created.id)}) · [Schedule](${cmd("customcopilot.showSchedule")})`
			);
			(result as unknown as { toolResultMessage?: vscode.MarkdownString }).toolResultMessage = md;
			return result;
		} finally {
			endMainActivity();
		}
	}
}

function text(value: string): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(value)]);
}

// ── Tree view ──────────────────────────────────────────────────────────

type Node = { kind: "event"; e: ScheduledEvent } | { kind: "history" } | { kind: "empty" };

export class ScheduleTreeProvider implements vscode.TreeDataProvider<Node> {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;
	private readonly subs: vscode.Disposable[] = [];

	constructor() {
		this.subs.push(scheduler.onDidChange(() => this.emitter.fire()));
		// Countdowns.
		const t = setInterval(() => this.emitter.fire(), 30_000);
		this.subs.push({ dispose: () => clearInterval(t) });
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			const pending = scheduler.pending().map((e): Node => ({ kind: "event", e }));
			const out: Node[] = pending.length ? pending : [{ kind: "empty" }];
			if (scheduler.finished().length) {
				out.push({ kind: "history" });
			}
			return out;
		}
		if (node.kind === "history") {
			return scheduler.finished().map((e) => ({ kind: "event", e }));
		}
		return [];
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === "empty") {
			const item = new vscode.TreeItem("No scheduled wake-ups");
			item.description = "+ to add a reminder";
			return item;
		}
		if (node.kind === "history") {
			const item = new vscode.TreeItem(`History (${scheduler.finished().length})`, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon("history");
			item.contextValue = "scheduleHistory";
			return item;
		}
		const e = node.e;
		const item = new vscode.TreeItem(e.reason);
		item.id = `${e.id}:${e.status}`;
		const pending = e.status === "pending";
		item.description = pending
			? `${e.waiting ? "due — waiting for the chat" : `in ${formatIn(e.dueAt - Date.now())}`} · ${formatWhen(e.dueAt)}${e.everyMs ? ` · ${formatEvery(e.everyMs)}` : ""}`
			: `${e.status}${e.lastPostedAt ? ` · ${formatWhen(e.lastPostedAt)}` : ""}${e.runs > 1 ? ` · ${e.runs} runs` : ""}`;
		item.iconPath = pending
			? new vscode.ThemeIcon(e.everyMs ? "sync" : e.waiting ? "bell-dot" : "clock")
			: new vscode.ThemeIcon(e.status === "done" ? "check" : e.status === "cancelled" ? "circle-slash" : "warning");
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${e.id}** — ${e.reason}\n\n`);
		md.appendMarkdown(`${pending ? `Due ${formatWhen(e.dueAt)}` : `Status: ${e.status}`}${e.everyMs ? ` · ${formatEvery(e.everyMs)}` : ""} · by ${e.createdBy === "agent" ? "the chat agent" : "you"}\n\n`);
		if (e.sessionTitle) {
			md.appendMarkdown(`Chat: ${e.sessionTitle}\n\n`);
		}
		md.appendCodeblock(e.prompt.length > 600 ? `${e.prompt.slice(0, 597)}…` : e.prompt, "text");
		item.tooltip = md;
		item.contextValue = pending ? "schedulePending" : "scheduleDone";
		item.command = { command: "customcopilot.showSchedule", title: "Show schedule", arguments: [e.id] };
		return item;
	}

	dispose(): void {
		for (const s of this.subs) {
			s.dispose();
		}
		this.emitter.dispose();
	}
}

/** id from a command argument: a string (links) or a tree node (menus). */
export function scheduleArg(arg: unknown): string {
	if (typeof arg === "string") {
		return arg;
	}
	const n = arg as { e?: { id?: string } } | undefined;
	return n?.e?.id ?? "";
}

// ── Commands ───────────────────────────────────────────────────────────

/** "+ New reminder" — prompt, when (minutes / HH:MM), optional repeat. */
export async function newReminder(): Promise<void> {
	const prompt = await vscode.window.showInputBox({
		title: "New scheduled wake-up (1/3)",
		prompt: "Message to post into the chat when it fires",
		placeHolder: "e.g. Check whether the CI run for this branch finished and fix failures",
		ignoreFocusOut: true,
	});
	if (!prompt?.trim()) {
		return;
	}
	const when = await vscode.window.showInputBox({
		title: "New scheduled wake-up (2/3)",
		prompt: 'When: minutes from now ("30"), a time ("14:30") or a date-time ("2026-11-07 09:00")',
		value: "30",
		ignoreFocusOut: true,
		validateInput: (v) => (/^\s*\d+(\.\d+)?\s*$/.test(v) || parseAt(v) !== undefined ? undefined : "Minutes, HH:MM or a date-time"),
	});
	if (!when) {
		return;
	}
	const repeat = await vscode.window.showQuickPick(
		[
			{ label: "Once", value: 0 },
			{ label: "Every 10 minutes", value: 600 },
			{ label: "Every 30 minutes", value: 1800 },
			{ label: "Every hour", value: 3600 },
			{ label: "Every day", value: 86400 },
		],
		{ title: "New scheduled wake-up (3/3) — repeat?" }
	);
	if (!repeat) {
		return;
	}
	const minutes = /^\s*\d+(\.\d+)?\s*$/.test(when) ? Number(when) : undefined;
	const session = agentManager.activeSession();
	const created = scheduler.create(
		{
			prompt,
			reason: prompt.split("\n")[0].slice(0, 80),
			...(minutes !== undefined ? { delaySeconds: minutes * 60 } : { at: when }),
			...(repeat.value ? { everySeconds: repeat.value } : {}),
		},
		"user",
		session,
		session ? agentManager.sessionInfos().find((s) => s.session === session)?.title : undefined
	);
	if (typeof created === "string") {
		vscode.window.showWarningMessage(created.replace(/^Error: /, ""));
		return;
	}
	vscode.window.showInformationMessage(`Wake-up ${created.id} scheduled for ${formatWhen(created.dueAt)}.`);
}

export async function editScheduled(id: string): Promise<void> {
	const e = scheduler.find(id);
	if (!e || e.status !== "pending") {
		return;
	}
	const prompt = await vscode.window.showInputBox({ title: `Edit wake-up ${e.id}`, prompt: "Message", value: e.prompt, ignoreFocusOut: true });
	if (prompt === undefined) {
		return;
	}
	const when = await vscode.window.showInputBox({
		title: `Edit wake-up ${e.id}`,
		prompt: 'When: minutes from now, HH:MM or a date-time (empty = keep)',
		placeHolder: formatWhen(e.dueAt),
		ignoreFocusOut: true,
	});
	if (when === undefined) {
		return;
	}
	const dueAt = !when.trim() ? undefined : /^\s*\d+(\.\d+)?\s*$/.test(when) ? Date.now() + Number(when) * 60_000 : parseAt(when);
	scheduler.update(e.id, { prompt, dueAt });
}

export function cancelScheduled(id: string): void {
	scheduler.cancel(id);
}

export function runScheduledNow(id: string): void {
	scheduler.runNow(id);
}

export function snoozeScheduled(id: string, minutes = 10): void {
	scheduler.snooze(id, minutes);
}

// ── Status bar ─────────────────────────────────────────────────────────

export function createScheduleStatusBar(): vscode.Disposable {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
	item.command = "customcopilot.showSchedule";
	const render = () => {
		const pending = scheduler.pending();
		if (pending.length === 0) {
			item.hide();
			return;
		}
		const next = pending[0];
		item.text = `$(${next.waiting ? "bell-dot" : "clock"}) ${next.waiting ? "due" : formatIn(next.dueAt - Date.now())}${pending.length > 1 ? ` +${pending.length - 1}` : ""}`;
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = { enabledCommands: ["customcopilot.runScheduledNow", "customcopilot.cancelScheduled", "customcopilot.snoozeScheduled", "customcopilot.showSchedule", "customcopilot.newReminder"] };
		md.appendMarkdown("**Scheduled wake-ups**\n\n");
		for (const e of pending.slice(0, 8)) {
			md.appendMarkdown(
				`$(${e.everyMs ? "sync" : "clock"}) **${formatWhen(e.dueAt)}** (${e.waiting ? "due" : `in ${formatIn(e.dueAt - Date.now())}`}) — ${e.reason.replace(/[[\]]/g, "")}  \n` +
					`[Run now](${cmd("customcopilot.runScheduledNow", e.id)}) · [Snooze 10m](${cmd("customcopilot.snoozeScheduled", e.id)}) · [Cancel](${cmd("customcopilot.cancelScheduled", e.id)})\n\n`
			);
		}
		md.appendMarkdown(`[Open schedule](${cmd("customcopilot.showSchedule")}) · [New reminder](${cmd("customcopilot.newReminder")})`);
		item.tooltip = md;
		item.show();
	};
	const sub = scheduler.onDidChange(render);
	const t = setInterval(render, 30_000);
	render();
	return vscode.Disposable.from(item, sub, { dispose: () => clearInterval(t) });
}

// ── Panel ──────────────────────────────────────────────────────────────

const PANEL_CSS = `
:root { --line: var(--vscode-panel-border, #555); --card: var(--vscode-editorWidget-background); --muted: var(--vscode-descriptionForeground); }
body { margin: 0; padding: 16px 20px 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
h1 { font-size: 16px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 22px 0 8px; }
.sub { color: var(--muted); font-size: 12px; margin-bottom: 14px; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:hover { opacity: .9; }
input, textarea, select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 13px; box-sizing: border-box; }
textarea { width: 100%; min-height: 60px; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: 12px; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder); }
.form { border: 1px solid var(--line); border-radius: 6px; padding: 12px; background: var(--card); display: grid; gap: 8px; }
.form .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.form .row > * { flex: 1 1 140px; }
.form .row > button { flex: 0 0 auto; }
.timeline { position: relative; padding-left: 18px; }
.timeline::before { content: ""; position: absolute; left: 6px; top: 6px; bottom: 6px; width: 2px; background: var(--line); }
.ev { position: relative; border: 1px solid var(--line); border-radius: 6px; background: var(--card); padding: 10px 12px; margin-bottom: 10px; }
.ev::before { content: ""; position: absolute; left: -17px; top: 14px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-button-background); border: 2px solid var(--vscode-editor-background); }
.ev.waiting::before { background: #d29922; animation: pulse 1.2s infinite; }
.ev.done::before { background: #3fb950; } .ev.cancelled::before, .ev.missed::before { background: #888; }
@keyframes pulse { 50% { opacity: .35; } }
.ev .top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ev .when { font-weight: 600; font-variant-numeric: tabular-nums; }
.ev .in { color: var(--vscode-textLink-foreground); font-variant-numeric: tabular-nums; }
.ev .reason { flex: 1 1 200px; }
.badge { font-size: 10px; padding: 1px 7px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.ev pre { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--muted); max-height: 140px; overflow: auto; }
.ev .acts { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.ev .hist { margin-top: 6px; font-size: 11px; color: var(--muted); }
.empty { color: var(--muted); padding: 8px 0; }
.focus { outline: 1px solid var(--vscode-focusBorder); }
`;

const PANEL_JS = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtIn = (ms) => { const s = Math.round(ms / 1000); if (s <= 0) return "now"; if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s"; const h = Math.floor(m / 60); return h < 48 ? h + "h " + (m % 60) + "m" : Math.round(h / 24) + " days"; };
const fmtWhen = (ms) => { const d = new Date(ms); const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); return new Date().toDateString() === d.toDateString() ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t; };
const fmtEvery = (ms) => "every " + fmtIn(ms).replace(/ 00s$/, "").replace(/ 0m$/, "");
let state = { pending: [], finished: [], focus: "" };
function card(e, pending) {
  const cls = pending ? (e.waiting ? "waiting" : "") : e.status;
  const hist = (e.history || []).slice(-3).map((h) => new Date(h.at).toLocaleTimeString() + " " + h.kind + (h.note ? " (" + esc(h.note) + ")" : "")).join(" · ");
  return '<div class="ev ' + cls + (state.focus === e.id ? " focus" : "") + '" id="ev-' + esc(e.id) + '">' +
    '<div class="top"><span class="when">' + (pending ? fmtWhen(e.dueAt) : (e.lastPostedAt ? fmtWhen(e.lastPostedAt) : fmtWhen(e.dueAt))) + "</span>" +
    (pending ? '<span class="in" data-due="' + e.dueAt + '">' + (e.waiting ? "due — waiting for the chat" : "in " + fmtIn(e.dueAt - Date.now())) + "</span>" : '<span class="badge">' + esc(e.status) + "</span>") +
    '<span class="reason">' + esc(e.reason) + "</span>" +
    (e.everyMs ? '<span class="badge">' + fmtEvery(e.everyMs) + (e.runsLeft != null ? " · " + e.runsLeft + " left" : "") + "</span>" : "") +
    '<span class="badge">' + esc(e.id) + " · " + (e.createdBy === "agent" ? "agent" : "you") + "</span></div>" +
    (e.sessionTitle ? '<div class="hist">Chat: ' + esc(e.sessionTitle) + "</div>" : "") +
    "<pre>" + esc(e.prompt) + "</pre>" +
    (pending ? '<div class="acts"><button class="primary" data-a="run" data-id="' + esc(e.id) + '">Run now</button><button data-a="snooze" data-m="10" data-id="' + esc(e.id) + '">+10 min</button><button data-a="snooze" data-m="60" data-id="' + esc(e.id) + '">+1 hour</button><button data-a="edit" data-id="' + esc(e.id) + '">Edit</button><button data-a="cancel" data-id="' + esc(e.id) + '">Cancel</button></div>' : "") +
    (hist ? '<div class="hist">' + hist + "</div>" : "") + "</div>";
}
function render() {
  const up = document.getElementById("up"), hist = document.getElementById("hist");
  up.innerHTML = state.pending.length ? state.pending.map((e) => card(e, true)).join("") : '<div class="empty">Nothing scheduled. The chat agent schedules wake-ups with #schedule; you can add a reminder above.</div>';
  hist.innerHTML = state.finished.length ? state.finished.map((e) => card(e, false)).join("") : '<div class="empty">No history yet.</div>';
  document.getElementById("count").textContent = state.pending.length ? state.pending.length + " pending" : "";
  for (const b of document.querySelectorAll("[data-a]")) b.onclick = () => vscode.postMessage({ type: b.dataset.a, id: b.dataset.id, minutes: Number(b.dataset.m || 10) });
  if (state.focus) { const el = document.getElementById("ev-" + state.focus); if (el) el.scrollIntoView({ block: "center" }); state.focus = ""; }
}
setInterval(() => { for (const el of document.querySelectorAll("[data-due]")) { if (!el.textContent.startsWith("due")) el.textContent = "in " + fmtIn(Number(el.dataset.due) - Date.now()); } }, 1000);
document.getElementById("add").onclick = () => {
  const prompt = document.getElementById("p").value.trim();
  if (!prompt) { document.getElementById("p").focus(); return; }
  vscode.postMessage({ type: "add", prompt, when: document.getElementById("w").value.trim(), every: Number(document.getElementById("r").value) });
  document.getElementById("p").value = "";
};
document.getElementById("clear").onclick = () => vscode.postMessage({ type: "clear" });
window.addEventListener("message", (ev) => { if (ev.data.type === "state") { state = { ...ev.data, focus: ev.data.focus || "" }; render(); } });
vscode.postMessage({ type: "ready" });
`;

export class SchedulePanel {
	private static current: SchedulePanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly subs: vscode.Disposable[] = [];

	static show(focusId?: string): void {
		if (SchedulePanel.current) {
			SchedulePanel.current.panel.reveal();
			SchedulePanel.current.push(focusId);
			return;
		}
		SchedulePanel.current = new SchedulePanel(focusId);
	}

	private constructor(private focusId?: string) {
		this.panel = vscode.window.createWebviewPanel("customcopilot.schedule", "Schedule", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		this.panel.iconPath = new vscode.ThemeIcon("clock");
		const nonce = randomBytes(16).toString("base64");
		this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Schedule</title><style nonce="${nonce}">${PANEL_CSS}</style></head>
<body>
<h1>⏰ Schedule <span class="badge" id="count"></span></h1>
<div class="sub">Wake-ups post their message into the chat when they come due (waiting until the chat is idle) and the agent continues from it. The chat agent creates them with <b>#schedule</b>.</div>
<div class="form">
  <textarea id="p" placeholder="Message to post into the chat — e.g. “Check the CI run for this branch and fix failures”"></textarea>
  <div class="row">
    <input id="w" value="30" title="Minutes from now, HH:MM or a date-time" placeholder="minutes / HH:MM / date-time">
    <select id="r"><option value="0">Once</option><option value="600">Every 10 min</option><option value="1800">Every 30 min</option><option value="3600">Every hour</option><option value="86400">Every day</option></select>
    <button class="primary" id="add">Add reminder</button>
  </div>
</div>
<h2>Upcoming</h2><div class="timeline" id="up"></div>
<h2>History <button id="clear" style="margin-left:8px">Clear</button></h2><div class="timeline" id="hist"></div>
<script nonce="${nonce}">const vscode = acquireVsCodeApi();${PANEL_JS}</script></body></html>`;
		this.subs.push(
			this.panel.onDidDispose(() => this.dispose()),
			scheduler.onDidChange(() => this.push()),
			this.panel.webview.onDidReceiveMessage((m: { type: string; id?: string; minutes?: number; prompt?: string; when?: string; every?: number }) => {
				switch (m.type) {
					case "ready":
						this.push(this.focusId);
						this.focusId = undefined;
						break;
					case "run":
						scheduler.runNow(String(m.id));
						break;
					case "snooze":
						scheduler.snooze(String(m.id), Number(m.minutes) || 10);
						break;
					case "cancel":
						scheduler.cancel(String(m.id));
						break;
					case "edit":
						void editScheduled(String(m.id));
						break;
					case "clear":
						scheduler.clearHistory();
						break;
					case "add": {
						const when = String(m.when ?? "").trim() || "30";
						const minutes = /^\d+(\.\d+)?$/.test(when) ? Number(when) : undefined;
						const session = agentManager.activeSession();
						const created = scheduler.create(
							{
								prompt: String(m.prompt ?? ""),
								...(minutes !== undefined ? { delaySeconds: minutes * 60 } : { at: when }),
								...(m.every ? { everySeconds: Number(m.every) } : {}),
							},
							"user",
							session,
							sessionTitle(session)
						);
						if (typeof created === "string") {
							vscode.window.showWarningMessage(created.replace(/^Error: /, ""));
						}
						break;
					}
				}
			})
		);
	}

	private push(focus?: string): void {
		void this.panel.webview.postMessage({ type: "state", pending: scheduler.pending(), finished: scheduler.finished(), focus });
	}

	private dispose(): void {
		SchedulePanel.current = undefined;
		for (const s of this.subs) {
			s.dispose();
		}
	}
}
