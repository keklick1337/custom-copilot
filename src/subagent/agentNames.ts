/** Tool names of the subagent tools (shared, no imports — avoids cycles). */
export const AGENT_TOOL_NAMES = {
	run: "customcopilot_delegateTask",
	list: "customcopilot_listAgents",
	send: "customcopilot_sendAgentMessage",
	wait: "customcopilot_waitForAgents",
	stop: "customcopilot_stopAgent",
	resume: "customcopilot_resumeAgent",
	// In-process write tools of write-enabled agents (not registered with vscode.lm).
	editFile: "customcopilot_agent_editFile",
	createFile: "customcopilot_agent_createFile",
	runCommand: "customcopilot_agent_runCommand",
} as const;

/** First line of an auto-resume chat message (also used to recognise such turns). */
export const AUTO_RESUME_HEADER = "📨 Background agent report";

/** The scheduling tool (wake-ups / reminders / recurring prompts). */
export const SCHEDULE_TOOL_NAME = "customcopilot_scheduleWakeup";

/** First line of a message posted by a scheduled wake-up. */
export const WAKEUP_HEADER = "⏰ Scheduled wake-up";
