import * as vscode from "vscode";
import { logger } from "../logger";
import { autoResumeDepth, noteMainCancelled } from "../chatActivity";
import { agentManager } from "../subagent/agentManager";
import { SCHEDULE_TOOL_NAME, WAKEUP_HEADER } from "../subagent/agentNames";

/**
 * Scheduled wake-ups (Claude Code's ScheduleWakeup / CronCreate): a prompt
 * that is posted into a chat session later — once (`delaySeconds` / `at`) or
 * repeatedly (`everySeconds`). The model schedules them with the
 * `#schedule` tool; the user can add reminders, run, snooze, edit or cancel
 * them from the Scheduled view, the Schedule panel or the status bar.
 *
 * - Events persist in globalState (they survive a reload). Events that came
 *   due while VS Code was closed are offered to the user ("Run now") instead
 *   of firing blindly.
 * - A due event waits until the chat is idle (like agent reports); if the
 *   user stopped the chat, a notification asks before posting.
 * - Loop guard: a wake-up turn may schedule further wake-ups only up to
 *   `customcopilot.schedule.maxChain` consecutive automatic turns.
 */

export type ScheduleStatus = "pending" | "done" | "cancelled" | "missed";

export interface ScheduleHistoryEntry {
	at: number;
	kind: "created" | "posted" | "snoozed" | "edited" | "cancelled" | "missed" | "failed" | "waiting";
	note?: string;
}

export interface ScheduledEvent {
	id: string;
	prompt: string;
	reason: string;
	/** Chat session URI to post into (undefined = the focused chat). */
	session?: string;
	sessionTitle?: string;
	createdAt: number;
	createdBy: "agent" | "user";
	dueAt: number;
	/** Recurring interval (ms). */
	everyMs?: number;
	/** Recurring: runs still allowed (undefined = until cancelled). */
	runsLeft?: number;
	runs: number;
	status: ScheduleStatus;
	lastPostedAt?: number;
	/** Set while a due event waits for the chat to become idle. */
	waiting?: boolean;
	history: ScheduleHistoryEntry[];
}

export interface ScheduleInput {
	action?: "schedule" | "list" | "cancel";
	prompt?: string;
	reason?: string;
	delaySeconds?: number;
	/** ISO date-time or "HH:MM" (today, or tomorrow when already past). */
	at?: string;
	everySeconds?: number;
	maxRuns?: number;
	id?: string;
}

const STATE_KEY = "customcopilot.schedule.v1";
const MAX_HISTORY = 40;
const MAX_FINISHED = 30;
const RETRY_MS = 15_000;
const MAX_DELAY_S = 30 * 24 * 3600;

function setting<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration().get<T>(`customcopilot.schedule.${key}`, fallback);
}

export function formatWhen(ms: number): string {
	const d = new Date(ms);
	const sameDay = new Date().toDateString() === d.toDateString();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function formatIn(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s <= 0) {
		return "now";
	}
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.round(s / 60);
	if (m < 60) {
		return `${m} min`;
	}
	const h = Math.floor(m / 60);
	return h < 48 ? `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `${Math.round(h / 24)} days`;
}

export function formatEvery(ms: number): string {
	return `every ${formatIn(ms)}`;
}

/** "HH:MM" today/tomorrow, or any Date-parsable string. */
export function parseAt(at: string, now = Date.now()): number | undefined {
	const hm = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(at);
	if (hm) {
		const d = new Date(now);
		d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
		if (d.getTime() <= now) {
			d.setDate(d.getDate() + 1);
		}
		return d.getTime();
	}
	const t = Date.parse(at);
	return Number.isFinite(t) ? t : undefined;
}

class Scheduler {
	private events: ScheduledEvent[] = [];
	private nextId = 1;
	private timer: NodeJS.Timeout | undefined;
	private memento: vscode.Memento | undefined;
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	/** Load persisted events and arm the timer; offer events missed while closed. */
	init(memento: vscode.Memento): void {
		this.memento = memento;
		const saved = memento.get<{ nextId: number; events: ScheduledEvent[] }>(STATE_KEY);
		this.events = Array.isArray(saved?.events) ? saved.events : [];
		this.nextId = Math.max(saved?.nextId ?? 1, 1);
		const now = Date.now();
		const overdue: ScheduledEvent[] = [];
		for (const e of this.events) {
			e.waiting = false;
			if (e.status !== "pending" || e.dueAt > now - 60_000) {
				continue;
			}
			if (e.everyMs) {
				// Recurring: skip the runs that fell into the closed period.
				const skipped = Math.floor((now - e.dueAt) / e.everyMs) + 1;
				e.dueAt += skipped * e.everyMs;
				this.log(e, "missed", `${skipped} run(s) skipped while VS Code was closed`);
			} else {
				overdue.push(e);
			}
		}
		this.save();
		this.arm();
		if (overdue.length > 0) {
			void this.offerOverdue(overdue);
		}
	}

	private async offerOverdue(overdue: ScheduledEvent[]): Promise<void> {
		const label = overdue.length === 1 ? `"${overdue[0].reason}"` : `${overdue.length} scheduled wake-ups`;
		const choice = await vscode.window.showInformationMessage(
			`${label} came due while VS Code was closed.`,
			"Run now",
			"Show schedule",
			"Dismiss"
		);
		if (choice === "Run now") {
			for (const e of overdue) {
				e.dueAt = Date.now();
			}
			this.save();
			this.arm();
		} else if (choice === "Show schedule") {
			void vscode.commands.executeCommand("customcopilot.showSchedule");
		} else {
			for (const e of overdue) {
				if (e.status === "pending" && e.dueAt <= Date.now()) {
					e.status = "missed";
					this.log(e, "missed", "dismissed after a restart");
				}
			}
			this.save();
		}
	}

	// ── Queries ────────────────────────────────────────────────────────

	list(): ScheduledEvent[] {
		return [...this.events];
	}

	pending(): ScheduledEvent[] {
		return this.events.filter((e) => e.status === "pending").sort((a, b) => a.dueAt - b.dueAt);
	}

	finished(): ScheduledEvent[] {
		return this.events
			.filter((e) => e.status !== "pending")
			.sort((a, b) => (b.lastPostedAt ?? b.dueAt) - (a.lastPostedAt ?? a.dueAt));
	}

	find(id: string): ScheduledEvent | undefined {
		const key = id.trim().toLowerCase();
		return this.events.find((e) => e.id.toLowerCase() === key);
	}

	/** Text listing for the tool. */
	describe(): string {
		const p = this.pending();
		if (p.length === 0) {
			return "No scheduled wake-ups.";
		}
		return p
			.map(
				(e) =>
					`- ${e.id} at ${formatWhen(e.dueAt)} (in ${formatIn(e.dueAt - Date.now())})${e.everyMs ? `, ${formatEvery(e.everyMs)}${e.runsLeft !== undefined ? `, ${e.runsLeft} run(s) left` : ""}` : ""}${e.waiting ? " — due, waiting for the chat to be idle" : ""}: ${e.reason}\n  prompt: ${e.prompt.length > 200 ? `${e.prompt.slice(0, 197)}…` : e.prompt}`
			)
			.join("\n");
	}

	// ── Mutations ──────────────────────────────────────────────────────

	/** Create an event; returns it or an error string. */
	create(input: ScheduleInput, by: "agent" | "user", session: string | undefined, sessionTitle?: string): ScheduledEvent | string {
		const prompt = String(input.prompt ?? "").trim();
		if (!prompt) {
			return "Error: `prompt` is required — the message that will be posted into the chat when the wake-up fires.";
		}
		const minDelay = Math.max(10, setting("minDelaySeconds", 60));
		const now = Date.now();
		let dueAt: number | undefined;
		if (input.at) {
			dueAt = parseAt(String(input.at), now);
			if (dueAt === undefined) {
				return `Error: cannot parse \`at\` "${input.at}" — use "HH:MM" or an ISO date-time.`;
			}
		} else if (input.delaySeconds !== undefined) {
			dueAt = now + Number(input.delaySeconds) * 1000;
		} else if (input.everySeconds !== undefined) {
			dueAt = now + Number(input.everySeconds) * 1000;
		}
		if (dueAt === undefined || !Number.isFinite(dueAt)) {
			return "Error: give `delaySeconds`, `at` or `everySeconds`.";
		}
		const delayS = (dueAt - now) / 1000;
		if (by === "agent" && delayS < minDelay) {
			return `Error: the earliest wake-up is in ${minDelay}s (customcopilot.schedule.minDelaySeconds).`;
		}
		if (delayS > MAX_DELAY_S) {
			return "Error: wake-ups can be at most 30 days ahead.";
		}
		let everyMs: number | undefined;
		if (input.everySeconds !== undefined) {
			const every = Number(input.everySeconds);
			const minEvery = by === "agent" ? minDelay : 10;
			if (!Number.isFinite(every) || every < minEvery) {
				return `Error: \`everySeconds\` must be at least ${minEvery}.`;
			}
			everyMs = Math.round(every * 1000);
		}
		if (by === "agent") {
			const maxPending = Math.max(1, setting("maxPending", 20));
			if (this.pending().length >= maxPending) {
				return `Error: ${maxPending} wake-ups are already pending (customcopilot.schedule.maxPending). Cancel one first.`;
			}
			const maxChain = Math.max(1, setting("maxChain", 25));
			if (autoResumeDepth() >= maxChain) {
				return `Error: ${maxChain} automatic turns in a row without a user message (customcopilot.schedule.maxChain) — not scheduling more. Tell the user where things stand instead.`;
			}
		}
		const maxRuns = input.maxRuns !== undefined ? Math.max(1, Math.floor(Number(input.maxRuns))) : undefined;
		const e: ScheduledEvent = {
			id: `w${this.nextId++}`,
			prompt,
			reason: String(input.reason ?? "").trim() || prompt.split("\n")[0].slice(0, 80),
			session,
			sessionTitle,
			createdAt: now,
			createdBy: by,
			dueAt,
			everyMs,
			runsLeft: everyMs ? maxRuns : undefined,
			runs: 0,
			status: "pending",
			history: [],
		};
		this.log(e, "created", `${by === "agent" ? "by the chat agent" : "by you"} for ${formatWhen(dueAt)}${everyMs ? `, ${formatEvery(everyMs)}` : ""}`);
		this.events.push(e);
		this.prune();
		this.save();
		this.arm();
		logger.info("schedule.create", { id: e.id, by, dueInS: Math.round(delayS), everyS: everyMs ? everyMs / 1000 : undefined });
		return e;
	}

	cancel(id: string): ScheduledEvent | undefined {
		const e = this.find(id);
		if (!e || e.status !== "pending") {
			return undefined;
		}
		e.status = "cancelled";
		e.waiting = false;
		this.log(e, "cancelled");
		this.save();
		this.arm();
		return e;
	}

	snooze(id: string, minutes: number): ScheduledEvent | undefined {
		const e = this.find(id);
		if (!e || e.status !== "pending") {
			return undefined;
		}
		e.dueAt = Math.max(Date.now(), e.dueAt) + minutes * 60_000;
		e.waiting = false;
		this.log(e, "snoozed", `to ${formatWhen(e.dueAt)}`);
		this.save();
		this.arm();
		return e;
	}

	update(id: string, patch: { prompt?: string; reason?: string; dueAt?: number; everyMs?: number | null }): ScheduledEvent | undefined {
		const e = this.find(id);
		if (!e || e.status !== "pending") {
			return undefined;
		}
		if (patch.prompt !== undefined && patch.prompt.trim()) {
			e.prompt = patch.prompt.trim();
		}
		if (patch.reason !== undefined && patch.reason.trim()) {
			e.reason = patch.reason.trim();
		}
		if (patch.dueAt !== undefined && Number.isFinite(patch.dueAt)) {
			e.dueAt = patch.dueAt;
		}
		if (patch.everyMs !== undefined) {
			e.everyMs = patch.everyMs && patch.everyMs >= 10_000 ? patch.everyMs : undefined;
		}
		this.log(e, "edited");
		this.save();
		this.arm();
		return e;
	}

	/** Fire now (still waits for an idle chat). */
	runNow(id: string): ScheduledEvent | undefined {
		const e = this.find(id);
		if (!e || e.status !== "pending") {
			return undefined;
		}
		e.dueAt = Date.now();
		this.save();
		this.arm();
		return e;
	}

	clearHistory(): void {
		this.events = this.events.filter((e) => e.status === "pending");
		this.save();
	}

	// ── Firing ─────────────────────────────────────────────────────────

	private arm(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const next = this.pending()[0];
		if (!next) {
			this.changeEmitter.fire();
			return;
		}
		// setTimeout overflows above ~24.8 days: re-arm in steps.
		const delay = Math.min(Math.max(0, next.dueAt - Date.now()), 6 * 3600_000);
		this.timer = setTimeout(() => void this.tick(), delay);
		this.changeEmitter.fire();
	}

	private async tick(): Promise<void> {
		this.timer = undefined;
		const now = Date.now();
		const due = this.pending().filter((e) => e.dueAt <= now);
		if (due.length === 0) {
			this.arm();
			return;
		}
		if (!setting("enabled", true)) {
			this.arm();
			return;
		}
		const state = agentManager.chatPostState();
		if (state === "busy") {
			// A turn is running: fire between turns, like Claude Code.
			for (const e of due) {
				if (!e.waiting) {
					e.waiting = true;
					this.log(e, "waiting", "the chat is busy");
				}
			}
			this.changeEmitter.fire();
			this.timer = setTimeout(() => void this.tick(), RETRY_MS);
			return;
		}
		if (state === "stopped") {
			this.askAfterStop(due);
			return;
		}
		// One message per tick: each wake-up starts its own turn.
		await this.post(due[0]);
		this.arm();
	}

	/** The user pressed Stop: posting would raise the pending-requests dialog — ask. */
	private askAfterStop(due: ScheduledEvent[]): void {
		for (const e of due) {
			e.waiting = true;
		}
		this.changeEmitter.fire();
		const e = due[0];
		void vscode.window
			.showInformationMessage(`Scheduled wake-up "${e.reason}" is due (the chat was stopped).`, "Post now", "Snooze 10 min", "Cancel it")
			.then(async (choice) => {
				if (choice === "Post now") {
					noteMainCancelled(false);
					await this.post(e);
				} else if (choice === "Snooze 10 min") {
					this.snooze(e.id, 10);
				} else if (choice === "Cancel it") {
					this.cancel(e.id);
				}
				this.arm();
			});
	}

	private async post(e: ScheduledEvent): Promise<void> {
		if (e.status !== "pending") {
			return;
		}
		e.runs++;
		const text = this.message(e);
		try {
			await agentManager.postToChat(e.session, text);
			e.lastPostedAt = Date.now();
			e.waiting = false;
			this.log(e, "posted", e.everyMs ? `run ${e.runs}` : undefined);
			if (e.everyMs && (e.runsLeft === undefined || e.runsLeft > 1)) {
				if (e.runsLeft !== undefined) {
					e.runsLeft--;
				}
				const now = Date.now();
				while (e.dueAt <= now) {
					e.dueAt += e.everyMs;
				}
			} else {
				if (e.runsLeft !== undefined) {
					e.runsLeft = 0;
				}
				e.status = "done";
			}
			logger.info("schedule.posted", { id: e.id, runs: e.runs });
		} catch (err) {
			e.runs--;
			this.log(e, "failed", err instanceof Error ? err.message : String(err));
			// Try again a bit later instead of losing it.
			e.dueAt = Date.now() + 60_000;
			logger.warn("schedule.post.failed", { id: e.id, error: err instanceof Error ? err.message : String(err) });
		}
		this.prune();
		this.save();
	}

	private message(e: ScheduledEvent): string {
		const recurring = e.everyMs
			? ` Recurring ${formatEvery(e.everyMs)} (run ${e.runs}${e.runsLeft !== undefined ? ` of ${e.runs + e.runsLeft - 1}` : ""}) — cancel it with {"action": "cancel", "id": "${e.id}"} when no longer needed.`
			: " Schedule another wake-up only if the task still needs one.";
		return (
			`${WAKEUP_HEADER} ${e.id} — ${e.reason}\n\n${e.prompt}\n\n---\n` +
			`_Posted automatically by a wake-up ${e.createdBy === "agent" ? "you scheduled" : "the user scheduled"} at ${formatWhen(e.createdAt)} with \`${SCHEDULE_TOOL_NAME}\`. It is not a new message typed by the user: carry out the prompt above.${recurring}_`
		);
	}

	private log(e: ScheduledEvent, kind: ScheduleHistoryEntry["kind"], note?: string): void {
		e.history.push({ at: Date.now(), kind, note });
		if (e.history.length > MAX_HISTORY) {
			e.history.splice(0, e.history.length - MAX_HISTORY);
		}
	}

	private prune(): void {
		const finished = this.finished();
		if (finished.length > MAX_FINISHED) {
			const drop = new Set(finished.slice(MAX_FINISHED).map((e) => e.id));
			this.events = this.events.filter((e) => !drop.has(e.id));
		}
	}

	private save(): void {
		void this.memento?.update(STATE_KEY, { nextId: this.nextId, events: this.events });
		this.changeEmitter.fire();
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
		}
		this.changeEmitter.dispose();
	}
}

export const scheduler = new Scheduler();
