import * as vscode from "vscode";
import { LanguageModelChatInformation, LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import { normalizeUserModels, parseModelId, resolveProxyUrl } from "./utils";

// Persistent state for diagnostics
interface DiagnosticsState {
	modelId: string;
	modelName: string;
	provider: string;
	messagesTokens: number;
	toolTokens: number;
	totalTokenCount: number;
	maxTokens: number;
	proxyUrl: string;
	isProxyUsed: boolean;
}

const lastStats: DiagnosticsState = {
	modelId: "N/A",
	modelName: "N/A",
	provider: "N/A",
	messagesTokens: 0,
	toolTokens: 0,
	totalTokenCount: 0,
	maxTokens: 0,
	proxyUrl: "none",
	isProxyUsed: false,
};

export function initStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
	// Create status bar item for token count display
	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = "Custom Copilot Status";
	tokenCountStatusBarItem.text = "$(sparkle) Copilot: Ready";
	tokenCountStatusBarItem.tooltip = new vscode.MarkdownString(
		"### 💫 **Custom Copilot Connection Diagnostics**\n\n" +
			"Status: **Ready**\n\n" +
			"Click to check token usage, proxy settings, or configure the extension."
	);
	tokenCountStatusBarItem.command = "customcopilot.showStatusBarMenu";
	context.subscriptions.push(tokenCountStatusBarItem);

	// Register command to show detailed diagnostic popup
	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.showStatusBarMenu", async () => {
			const items: vscode.QuickPickItem[] = [
				{
					label: `$(hubot) Active Model: ${lastStats.modelName}`,
					description: `Family: ${lastStats.provider}`,
					detail: `Identifier: ${lastStats.modelId}`,
				},
				{
					label: `$(symbol-parameter) Usage: ${formatTokenCount(lastStats.totalTokenCount)} / ${formatTokenCount(lastStats.maxTokens)}`,
					description:
						lastStats.maxTokens > 0 ? `${((lastStats.totalTokenCount / lastStats.maxTokens) * 100).toFixed(1)}%` : "0%",
					detail: `Prompt-to-Response Window: Messages (${formatTokenCount(lastStats.messagesTokens)}) • Tools (${formatTokenCount(lastStats.toolTokens)})`,
				},
				{
					label: `$(globe) Network Proxy: ${lastStats.isProxyUsed ? "Configured" : "Direct Connection"}`,
					description: lastStats.isProxyUsed ? `${lastStats.proxyUrl}` : "Bypass (No Proxy)",
					detail: lastStats.isProxyUsed
						? "Sourced proxy is active for all outgoing target endpoints."
						: "Direct standard NAT routing bypasses active proxies.",
				},
				{
					label: "",
					kind: vscode.QuickPickItemKind.Separator,
				},
				{
					label: "$(gear) Configure Custom Copilot",
					description: "Launch sidebar settings panel",
				},
			];

			const selected = await vscode.window.showQuickPick(items, {
				title: "Custom Copilot - Connection & Token Diagnostics",
				placeHolder: "Select a configuration item or execute adjustments",
			});

			if (selected?.label === "$(gear) Configure Custom Copilot") {
				await vscode.commands.executeCommand("customcopilot.openConfig");
			}
		})
	);

	// Show the status bar item initially
	tokenCountStatusBarItem.show();
	return tokenCountStatusBarItem;
}

/**
 * Format number to thousands (K, M, B) format
 * @param value The number to format
 * @returns Formatted string (e.g., "2.3K", "168.0K")
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Create a visual progress bar showing token usage
 * @param usedTokens Tokens used
 * @param maxTokens Maximum tokens available
 * @returns Progress bar string (e.g., "▆ 75.2%")
 */
export function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
	const usagePercentage = Math.min((usedTokens / maxTokens) * 100, 100);
	const blockIndex = Math.min(Math.floor((usagePercentage / 100) * blocks.length), blocks.length - 1);

	return `${blocks[blockIndex]} ${usagePercentage.toFixed(1)}%`;
}

/**
 * Update the status bar with token usage information
 * @param messages The chat messages to count tokens for
 * @param tools Optional tool definitions to count tokens for
 * @param model The language model information
 * @param statusBarItem The status bar item to update
 * @param modelConfig Configuration including reasoning settings
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	model: LanguageModelChatInformation,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<void> {
	// Calculate tokens for all messages in parallel
	const tokenCountPromises = messages.map((message) => countMessageTokens(message, modelConfig));

	const tokenCounts = await Promise.all(tokenCountPromises);
	const messagesTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

	// Calculate tool definition tokens
	let toolTokens = 0;
	if (tools && tools.length > 0) {
		toolTokens = await countToolTokens(tools);
	}

	// Total tokens: messages + tool definitions + reserved output
	const totalTokenCount = messagesTokens + toolTokens;
	const maxTokens = model.maxInputTokens + model.maxOutputTokens;

	// Populate persistent stats for QuickPick diagnosis
	lastStats.modelId = model.id;
	lastStats.modelName = model.name;
	lastStats.provider = model.family ?? "customcopilot";
	lastStats.messagesTokens = messagesTokens;
	lastStats.toolTokens = toolTokens;
	lastStats.totalTokenCount = totalTokenCount;
	lastStats.maxTokens = maxTokens;

	// Query workspace configuration to resolve proxy URL
	const config = vscode.workspace.getConfiguration();
	const globalProxyUrl = config.get<string>("customcopilot.proxyUrl", "").trim();
	const userModels = normalizeUserModels(config.get<unknown>("customcopilot.models", []));
	const parsedModelId = parseModelId(model.id);

	let um = userModels.find(
		(u) =>
			u.id === parsedModelId.baseId &&
			((parsedModelId.configId && u.configId === parsedModelId.configId) || (!parsedModelId.configId && !u.configId))
	);
	if (!um) {
		um = userModels.find((u) => u.id === parsedModelId.baseId);
	}

	const activeProxy = resolveProxyUrl(um?.proxyUrl, globalProxyUrl);
	if (activeProxy) {
		lastStats.proxyUrl = activeProxy;
		lastStats.isProxyUsed = true;
	} else {
		lastStats.proxyUrl = "Direct";
		lastStats.isProxyUsed = false;
	}

	// Create visual progress bar with single progressive block
	const progressBar = createProgressBar(totalTokenCount, maxTokens);
	const displayText = `$(sparkle) ${progressBar}`;
	statusBarItem.text = displayText;

	// Format a gorgeous Markdown tooltip with status list and interactive command action
	const tooltipMarkdown = new vscode.MarkdownString();
	tooltipMarkdown.isTrusted = true;
	tooltipMarkdown.appendMarkdown(`### 💫 **Custom Copilot Diagnostics**\n\n`);
	tooltipMarkdown.appendMarkdown(`- **Active Model**: \`${model.name}\`\n`);
	tooltipMarkdown.appendMarkdown(`- **Context Limit**: ${formatTokenCount(maxTokens)} tokens\n`);
	tooltipMarkdown.appendMarkdown(`- **Usage Intensity**: ${progressBar} (${formatTokenCount(totalTokenCount)} used)\n`);
	tooltipMarkdown.appendMarkdown(
		`- **Messages Contribution**: ${formatTokenCount(messagesTokens)} (${Math.min((messagesTokens / maxTokens) * 100, 100).toFixed(1)}%)\n`
	);
	tooltipMarkdown.appendMarkdown(
		`- **Tool Definitions**: ${formatTokenCount(toolTokens)} (${Math.min((toolTokens / maxTokens) * 100, 100).toFixed(1)}%)\n`
	);
	tooltipMarkdown.appendMarkdown(
		`- **Network Routing**: ${lastStats.isProxyUsed ? `🌐 Proxy (\`${lastStats.proxyUrl}\`)` : "🔌 Direct Connection"}\n\n`
	);
	tooltipMarkdown.appendMarkdown(`---\n\n`);
	tooltipMarkdown.appendMarkdown(`[⚙️ Open Settings](command:customcopilot.openConfig)`);

	statusBarItem.tooltip = tooltipMarkdown;

	// Add color coding based on token usage
	const usagePercentage = (totalTokenCount / maxTokens) * 100;
	if (usagePercentage >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
	} else if (usagePercentage >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
	} else {
		statusBarItem.backgroundColor = undefined;
	}

	statusBarItem.show();
}
