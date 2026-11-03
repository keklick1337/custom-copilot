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
