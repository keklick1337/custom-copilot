import * as vscode from "vscode";
import { CustomEndpointChatProvider } from "./provider";
import type { CustomApiMode, CustomModelItem } from "./types";
import { initStatusBar } from "./statusBar";
import { SettingsViewProvider } from "./views/configView";
import { setSkillsContext } from "./views/skillsController";
import { logger } from "./logger";
import { normalizeUserModels } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { keyBalancer } from "./keyBalancer";

/**
 * Single source of truth for the vendor list: vendor id (must match
 * package.json → contributes.languageModelChatProviders), its apiMode, the
 * picker display name and the default base URL advertised to VS Code's BYOK
 * group UI. Previously maintained as two hand-copied arrays that could drift.
 */
const VENDOR_MODES: ReadonlyArray<{
	vendor: string;
	mode: CustomApiMode;
	displayName: string;
	defaultBaseUrl: string;
}> = [
	{ vendor: "copilotcustommodelsendpoint", mode: "openai", displayName: "Custom OpenAI", defaultBaseUrl: "https://api.openai.com/v1" },
	{ vendor: "copilotcustommodelsendpoint-responses", mode: "openai-responses", displayName: "Custom OpenAI Responses", defaultBaseUrl: "https://api.openai.com/v1" },
	{ vendor: "copilotcustommodelsendpoint-anthropic", mode: "anthropic", displayName: "Custom Anthropic", defaultBaseUrl: "https://api.anthropic.com/v1" },
	{ vendor: "copilotcustommodelsendpoint-gemini", mode: "gemini", displayName: "Custom Gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
	{ vendor: "copilotcustommodelsendpoint-ollama", mode: "ollama", displayName: "Custom Ollama", defaultBaseUrl: "http://localhost:11434" },
	{ vendor: "copilotcustommodelsendpoint-zai", mode: "zai", displayName: "Z.AI Free", defaultBaseUrl: "https://api.z.ai/api/anthropic" },
];

export function activate(context: vscode.ExtensionContext) {
	// Share the extension context with the skills screen (catalog cache storage).
	setSkillsContext(context);
	// Initialize logger
	logger.init();

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	// Wire persistence for per-API-key usage/error counters (key health table).
	keyBalancer.init(context);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);

	// Register one provider per apiMode so each protocol shows up as a separate
	// group in the model picker (mirrors how Copilot BYOK lists OpenAI/Anthropic/…
	// as distinct groups). Vendor ids must match the static declarations in
	// package.json → contributes.languageModelChatProviders.
	const vendorModes = VENDOR_MODES;
	for (const { vendor, mode } of vendorModes) {
		const provider = new CustomEndpointChatProvider(context.secrets, tokenCountStatusBarItem, mode);
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(vendor, provider));
	}

	// Privacy default (anonymity): on first activation, disable VS Code telemetry so the
	// selected model id is not reported via the core "interactiveSessionProviderInvoked"
	// event, which would otherwise reveal which third-party providers/models are used.
	// Applied only once; the user can re-enable telemetry afterwards without it being reverted.
	void applyTelemetryPrivacyDefault(context);

	// One-time migration: assign configId to existing models that share the same
	// id under the same apiMode (VS Code vendor).  Without this, VS Code silently
	// deduplicates them and only the first survives in the model picker.
	void migrateDuplicateModelIds(context);

	// Ensure VS Code has a provider group for each of our vendors so that
	// `hasByokModels` becomes true — this lets signed-out users use Copilot
	// Chat with our BYOK models without the "Sign in to use Copilot" gate.
	// VS Code only sets `github.copilot.hasByokModels` = true when
	// `chatLanguageModels.json` contains a non-Copilot vendor group.  We create
	// one per vendor via the internal `lm.addLanguageModelsProviderGroup`
	// command.  This is idempotent: adding a group that already exists is a
	// no-op (VS Code deduplicates by vendor+name).
	void ensureByokProviderGroups(context);

	// One-time opt-in for the Agents-panel BYOK bridge: the new Agents view
	// only shows models targeting its session type, so this extension's models
	// are invisible there unless VS Code's experimental
	// `chat.agentHost.byokModels.enabled` is on.  Enable it once (respecting an
	// explicit user choice of "off") so models work out of the box.
	void enableAgentHostByokOnce(context);

	// Management command to configure provider-specific API keys
	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.setProviderApikey", async () => {
			// Get provider list from configuration
			const config = vscode.workspace.getConfiguration();
			const userModels = normalizeUserModels(config.get<CustomModelItem[]>("customcopilot.models", []));

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
			const selectedProviderRaw = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});

			if (!selectedProviderRaw) {
				return; // user canceled
			}
			// Normalize exactly like the read path (provider.ts lowercases/trims
			// on lookup) so the stored secret key always matches.
			const selectedProvider = selectedProviderRaw.trim().toLowerCase();

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

	// Quick per-model capability toggles from the command palette — pick a
	// model, then flip tools/vision/thinking without opening the webview.
	// Saving notifies the language-model providers so the picker updates live.
	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.toggleModelCapability", async () => {
			const config = vscode.workspace.getConfiguration();
			const models = normalizeUserModels(config.get<CustomModelItem[]>("customcopilot.models", []));
			const usable = models.filter((m) => !m.id.startsWith("__provider__"));
			if (usable.length === 0) {
				vscode.window.showInformationMessage("No models configured. Add models in the Custom Copilot panel first.");
				return;
			}
			const picked = await vscode.window.showQuickPick(
				usable.map((m) => ({
					label: m.displayName || m.id,
					description: `${m.owned_by}${m.configId ? ` :: ${m.configId}` : ""}`,
					detail: `tools: ${!!(m.tool_calling ?? m.extra?.tool_calling)} · vision: ${!!m.vision} · thinking: ${!!(m.enable_thinking ?? m.reasoning?.enabled ?? (m.thinking?.type === "enabled"))}`,
					model: m,
				})),
				{ title: "Toggle Model Capability — pick a model", placeHolder: "Select a model" }
			);
			if (!picked) {
				return;
			}
			const target = picked.model;
			const cap = await vscode.window.showQuickPick(
				[
					{ label: "$(tools) Tool calling (agent mode)", id: "tools" },
					{ label: "$(eye) Vision / image input", id: "vision" },
					{ label: "$(lightbulb) Thinking / reasoning", id: "thinking" },
				] as Array<{ label: string; id: "tools" | "vision" | "thinking" }>,
				{ title: `Toggle capability — ${picked.label}`, placeHolder: "Select capability to toggle" }
			);
			if (!cap) {
				return;
			}
			const updated = models.map((m) => {
				if (m !== target) {
					return m;
				}
				const next = { ...m };
				if (cap.id === "tools") {
					const cur = next.tool_calling ?? next.extra?.tool_calling === true;
					next.tool_calling = !cur;
					if (next.extra && "tool_calling" in next.extra) {
						next.extra = { ...next.extra, tool_calling: !cur };
					}
				} else if (cap.id === "vision") {
					next.vision = !next.vision;
				} else {
					const cur = !!(next.enable_thinking ?? next.reasoning?.enabled ?? next.thinking?.type === "enabled");
					next.enable_thinking = !cur;
					if (!cur) {
						// Turning thinking on: give Responses models a sensible default effort.
						next.reasoning_effort = next.reasoning_effort ?? "medium";
					}
				}
				return next;
			});
			await config.update("customcopilot.models", updated, vscode.ConfigurationTarget.Global);
			CustomEndpointChatProvider.notifyModelsChanged();
			vscode.window.showInformationMessage(`Updated ${cap.id} for ${picked.label}.`);
		})
	);

	// Quick-pick the commit-message model from the command palette (equivalent
	// to the webview's Git Commit Settings dropdown, but reachable anywhere).
	context.subscriptions.push(
		vscode.commands.registerCommand("customcopilot.setDefaultModel", async () => {
			const config = vscode.workspace.getConfiguration();
			const models = normalizeUserModels(config.get<CustomModelItem[]>("customcopilot.models", []));
			const usable = models.filter((m) => !m.id.startsWith("__provider__"));
			if (usable.length === 0) {
				vscode.window.showInformationMessage("No models configured. Add models in the Custom Copilot panel first.");
				return;
			}
			const current = usable.find((m) => m.useForCommitGeneration === true);
			const picked = await vscode.window.showQuickPick(
				[
					{ label: "$(close) None (disable commit generation)", id: "" },
					...usable.map((m) => ({
						label: `${m.useForCommitGeneration ? "$(check) " : ""}${m.displayName || m.id}`,
						description: m.owned_by,
						detail: m.configId ? `config: ${m.configId}` : undefined,
						id: m,
					})),
				],
				{
					title: "Commit Message Model" + (current ? ` — current: ${current.displayName || current.id}` : ""),
					placeHolder: "Pick the model used for SCM commit messages",
				}
			);
			if (!picked) {
				return;
			}
			const updated = models.map((m) => {
				const next = { ...m };
				if (picked.id && typeof picked.id !== "string" && m === picked.id) {
					next.useForCommitGeneration = true;
				} else {
					delete next.useForCommitGeneration;
				}
				return next;
			});
			await config.update("customcopilot.models", updated, vscode.ConfigurationTarget.Global);
			CustomEndpointChatProvider.notifyModelsChanged();
			const chosen = typeof picked.id === "object" ? picked.id : undefined;
			vscode.window.showInformationMessage(
				chosen ? `Commit messages will use ${chosen.displayName || chosen.id}.` : "Commit generation disabled."
			);
		})
	);

	// Watch for logLevel configuration changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("customcopilot.logLevel")) {
				logger.reloadConfig();
			}
			// When the user adds/removes/edits models (via the webview UI,
			// settings.json, or the one-time migration), notify VS Code so the
			// language-model provider re-resolves and the model picker updates
			// IMMEDIATELY — no window reload / restart required.
			if (e.affectsConfiguration("customcopilot.models")) {
				CustomEndpointChatProvider.notifyModelsChanged();
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

/**
 * One-time migration: VS Code deduplicates language models by
 * `vendor/${id::configId}` within each vendor.  Models that share the same
 * `id` and the same effective `apiMode` (the VS Code vendor) collide — VS Code
 * silently skips all but the first.  This migration scans existing
 * `customcopilot.models` and assigns a numeric `configId` (`"1"`, `"2"`, …)
 * to duplicates so every model appears in the picker.
 *
 * Runs once (guarded by globalState).  Models that already have a `configId`
 * are preserved.  The first occurrence of each id keeps no configId (backward
 * compatible).  This is a pure in-memory array operation — it completes in
 * milliseconds even for hundreds of models.
 *
 * Models with the same `id` but **different** `apiMode` are under different VS
 * Code vendors, so they do NOT collide and are left untouched.
 */
async function migrateDuplicateModelIds(context: vscode.ExtensionContext): Promise<void> {
	const STATE_KEY = "customcopilot.modelIdMigrationV1";
	if (context.globalState.get<boolean>(STATE_KEY)) {
		return;
	}
	await context.globalState.update(STATE_KEY, true);

	try {
		const config = vscode.workspace.getConfiguration();
		const rawModels = config.get<CustomModelItem[]>("customcopilot.models", []);
		const models = normalizeUserModels(rawModels);
		if (!models.length) {
			return;
		}

		// Group models by (id, effective apiMode).  VS Code vendors are per-apiMode,
		// so only models sharing the same apiMode can collide.
		const groups = new Map<string, CustomModelItem[]>();
		for (const m of models) {
			if (m.id.startsWith("__provider__")) {
				continue;
			}
			const effectiveMode = m.apiMode ?? "openai";
			const key = `${m.id}\0${effectiveMode}`;
			let group = groups.get(key);
			if (!group) {
				group = [];
				groups.set(key, group);
			}
			group.push(m);
		}

		let changed = false;
		for (const group of groups.values()) {
			if (group.length <= 1) {
				continue;
			}
			// Collect existing identifiers within this group (id or id::configId).
			const usedIds = new Set<string>();
			for (const m of group) {
				const fullId = m.configId ? `${m.id}::${m.configId}` : m.id;
				usedIds.add(fullId);
			}

			// For models without a configId whose plain id already collides,
			// assign a numeric configId.  The first model with no configId keeps
			// its bare id; subsequent duplicates get "1", "2", etc.
			let counter = 1;
			for (const m of group) {
				if (m.configId) {
					continue;
				}
				const fullId = m.id;
				if (!usedIds.has(fullId)) {
					usedIds.add(fullId);
					continue;
				}
				// This id is already taken — find the next available numeric configId.
				while (usedIds.has(`${m.id}::${counter}`)) {
					counter++;
				}
				m.configId = String(counter);
				usedIds.add(`${m.id}::${counter}`);
				changed = true;
			}
		}

		if (changed) {
			await config.update("customcopilot.models", models, vscode.ConfigurationTarget.Global);
			logger.info("models.migrated", { count: models.length });
		}
	} catch (err) {
		logger.warn("models.migration.failed", { error: String(err) });
	}
}

/**
 * Creates a provider group in VS Code's `chatLanguageModels.json` for each of
 * our vendors.  This is what makes `github.copilot.hasByokModels` become true,
 * allowing signed-out users to use Copilot Chat with BYOK models.
 *
 * VS Code only considers a user to "have BYOK models" when there's at least
 * one non-Copilot vendor group in the language-models config file.  Just
 * registering a `LanguageModelChatProvider` (even with `isBYOK: true`) is not
 * enough — the group must be persisted.  We use the internal
 * `lm.addLanguageModelsProviderGroup` command to create a minimal group per
 * vendor.
 *
 * Runs on EVERY activation (not just once): the command throws when the group
 * already exists, which we treat as success.  Retrying also covers the case
 * where VS Code added new vendors in an extension update, or an earlier run
 * failed because the command wasn't registered yet during startup.  A short
 * delay lets the workbench finish registering its actions first.
 */
async function ensureByokProviderGroups(_context: vscode.ExtensionContext): Promise<void> {
	const vendors = VENDOR_MODES;

	// Wait a moment so the workbench's command registrations are in place.
	await new Promise((resolve) => setTimeout(resolve, 2000));

	let created = 0;
	for (const v of vendors) {
		try {
			await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
				name: v.displayName,
				vendor: v.vendor,
				baseUrl: v.defaultBaseUrl,
			});
			created++;
			logger.info("byok.groupCreated", { vendor: v.vendor });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// "already exists" / duplicate failures are SUCCESS — the durable
			// group is already in place.  Other failures (command not yet
			// registered, entitlement gate) are logged; the user can still
			// configure manually via "Manage Models → Configure".
			if (/exist|duplicate/i.test(message)) {
				logger.debug("byok.groupAlreadyExists", { vendor: v.vendor });
			} else {
				logger.debug("byok.groupCreate.skipped", { vendor: v.vendor, error: message });
			}
		}
	}
	if (created > 0) {
		logger.info("byok.groupsReady", { created });
	}
}

/**
 * One-time opt-in for the Agents-panel BYOK bridge
 * (`chat.agentHost.byokModels.enabled`).  The new Agents view filters its
 * model picker to models targeting its session type, so extension BYOK models
 * are invisible there unless this experimental setting is on.  We enable it
 * once on first activation; if the user explicitly turns it OFF via the
 * webview toggle we respect that and never re-enable (guarded by globalState
 * "off" marker checked in configView before calling, and here by the fact
 * that we only write when the key is undefined).
 */
async function enableAgentHostByokOnce(_context: vscode.ExtensionContext): Promise<void> {
	try {
		const config = vscode.workspace.getConfiguration();
		const inspect = config.inspect<boolean | undefined>("chat.agentHost.byokModels.enabled");
		// Only set when the user has never chosen a value themselves.
		if (
			inspect?.globalValue !== undefined ||
			inspect?.workspaceValue !== undefined ||
			inspect?.workspaceFolderValue !== undefined
		) {
			return;
		}
		await config.update("chat.agentHost.byokModels.enabled", true, vscode.ConfigurationTarget.Global);
		logger.info("agentHost.byok.enabledByDefault", {});
	} catch (err) {
		// Older VS Code versions don't have this setting registered — non-fatal.
		logger.debug("agentHost.byok.enableSkipped", { error: String(err) });
	}
}
