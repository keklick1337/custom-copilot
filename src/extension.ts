import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFApiMode, HFModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { SettingsViewProvider } from "./views/configView";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger
	logger.init();

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);

	// Register one provider per apiMode so each protocol shows up as a separate
	// group in the model picker (mirrors how Copilot BYOK lists OpenAI/Anthropic/…
	// as distinct groups). Vendor ids must match the static declarations in
	// package.json → contributes.languageModelChatProviders.
	const vendorModes: ReadonlyArray<{ vendor: string; mode: HFApiMode }> = [
		{ vendor: "copilotcustommodelsendpoint", mode: "openai" },
		{ vendor: "copilotcustommodelsendpoint-responses", mode: "openai-responses" },
		{ vendor: "copilotcustommodelsendpoint-anthropic", mode: "anthropic" },
		{ vendor: "copilotcustommodelsendpoint-gemini", mode: "gemini" },
		{ vendor: "copilotcustommodelsendpoint-ollama", mode: "ollama" },
	];
	for (const { vendor, mode } of vendorModes) {
		const provider = new HuggingFaceChatModelProvider(context.secrets, tokenCountStatusBarItem, mode);
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(vendor, provider));
	}

	// Privacy default (anonymity): on first activation, disable VS Code telemetry so the
	// selected model id is not reported via the core "interactiveSessionProviderInvoked"
	// event, which would otherwise reveal which third-party providers/models are used.
	// Applied only once; the user can re-enable telemetry afterwards without it being reverted.
	void applyTelemetryPrivacyDefault(context);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<HFModelItem[]>("customcopilot.models", []));

			// Extract unique providers (case-insensitive)
			const providers = Array.from(
				new Set(userModels.map((m) => m.owned_by.toLowerCase()).filter((p) => p && p.trim() !== ""))
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found in customcopilot.models configuration. Please configure models first."
				);
				return;
			}

			// Let user select provider
			const selectedProvider = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProvider) {
				return; // user canceled
			}

			// Get existing API key for selected provider
			const providerKey = `customcopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			// Prompt for API key
			const apiKey = await vscode.window.showInputBox({
				title: `API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return; // user canceled
			}

			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}

			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SettingsViewProvider.viewType,
			new SettingsViewProvider(context.extensionUri, context.secrets)
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.openConfig", async () => {
			await vscode.commands.executeCommand("customcopilot.settingsView.focus");
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("customcopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("customcopilot.logLevel")) {
				logger.reloadConfig();
			}
		})
	);
}

export function deactivate() {}

/**
 * On the very first activation, disable VS Code telemetry to keep the user's
 * third-party API providers private (anonymity by default). VS Code core reports
 * the selected model id via the "interactiveSessionProviderInvoked" telemetry
 * event; setting `telemetry.telemetryLevel` to "off" prevents that leak.
 *
 * This runs only once (guarded by globalState). If the user re-enables telemetry
 * later, it is never reverted. It also never overrides an explicit existing choice.
 */
async function applyTelemetryPrivacyDefault(context: vscode.ExtensionContext): Promise<void> {
	const STATE_KEY = "customcopilot.telemetryPrivacyApplied";
	if (context.globalState.get<boolean>(STATE_KEY)) {
		return;
	}
	await context.globalState.update(STATE_KEY, true);

	const config = vscode.workspace.getConfiguration();
	const inspected = config.inspect<string>("telemetry.telemetryLevel");
	const hasExplicitChoice =
		inspected?.globalValue !== undefined ||
		inspected?.workspaceValue !== undefined ||
		inspected?.workspaceFolderValue !== undefined;

	// Respect the user's own explicit setting if they already configured one.
	if (hasExplicitChoice) {
		return;
	}

	try {
		await config.update("telemetry.telemetryLevel", "off", vscode.ConfigurationTarget.Global);
		const choice = await vscode.window.showInformationMessage(
			"Custom Copilot disabled VS Code telemetry to keep your API providers private. " +
				"You can change this anytime in the Custom Copilot configuration.",
			"Open Config",
			"Re-enable Telemetry"
		);
		if (choice === "Open Config") {
			await vscode.commands.executeCommand("customcopilot.openConfig");
		} else if (choice === "Re-enable Telemetry") {
			await config.update("telemetry.telemetryLevel", "all", vscode.ConfigurationTarget.Global);
		}
	} catch (err) {
		logger.warn("telemetry.privacyDefault.failed", { error: String(err) });
	}
}
