import * as path from "path";
import * as vscode from "vscode";
import { getGitDiff } from "./gitUtils";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { OllamaApi } from "../ollama/ollamaApi";
import { GeminiApi } from "../gemini/geminiApi";
import { normalizeUserModels, resolveProxyUrl } from "../utils";
import { logger } from "../logger";
import { keyBalancer, parseApiKeys } from "../keyBalancer";
import { resolveApiKeysFromSource } from "../apiKeySource";
import type { CustomModelItem } from "../types";

/** Minimal shape of the built-in git extension's Repository we rely on. */
interface GitRepository {
	rootUri: vscode.Uri;
	inputBox: { value: string };
}

/** Minimal shape of the built-in git extension's API (v1). */
interface GitApi {
	repositories: GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtensionExports {
	getAPI(version: 1): GitApi;
}

/**
 * Git commit message generator module
 */

/** Every in-flight generation (multi-repo "generate all" runs several at once). */
const commitGenerationAbortControllers = new Set<AbortController>();

const DEFAULT_PROMPT = {
	system:
		"You are a helpful assistant that generates informative git commit messages based on git diffs output. Skip preamble and remove all backticks surrounding the commit message.\nBased on the provided git diff, generate a conventional format commit message.",
	user: "Notes from developer (ignore if not relevant): {{USER_CURRENT_INPUT}}",
};

export async function generateCommitMsg(secrets: vscode.SecretStorage, scm?: vscode.SourceControl) {
	try {
		const gitExtension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git")?.exports;
		if (!gitExtension) {
			throw new Error("Git extension not found");
		}

		const git = gitExtension.getAPI(1);
		if (git.repositories.length === 0) {
			throw new Error("No Git repositories available");
		}

		// If scm is provided, then the user specified one repository by clicking the "Source Control" menu button
		if (scm) {
			const repository = scm.rootUri ? git.getRepository(scm.rootUri) : null;

			if (!repository) {
				throw new Error("Repository not found for provided SCM");
			}

			await generateCommitMsgForRepository(secrets, repository);
			return;
		}

		await orchestrateWorkspaceCommitMsgGeneration(secrets, git.repositories);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`[Commit Generation Failed] ${errorMessage}`);
	}
}

async function orchestrateWorkspaceCommitMsgGeneration(secrets: vscode.SecretStorage, repos: GitRepository[]) {
	const reposWithChanges = await filterForReposWithChanges(repos);

	if (reposWithChanges.length === 0) {
		vscode.window.showInformationMessage(`No changes found in any workspace repositories.`);
		return;
	}

	if (reposWithChanges.length === 1) {
		// Only one repo with changes, generate for it
		const repo = reposWithChanges[0];
		await generateCommitMsgForRepository(secrets, repo);
		return;
	}

	const selection = await promptRepoSelection(reposWithChanges);

	if (!selection) {
		// User cancelled
		return;
	}

	if (selection.repo === null) {
		// Generate for all repositories with changes
		for (const repo of reposWithChanges) {
			try {
				await generateCommitMsgForRepository(secrets, repo);
			} catch (error) {
				console.error(`Failed to generate commit message for ${repo.rootUri.fsPath}:`, error);
			}
		}
	} else {
		// Generate for selected repository
		await generateCommitMsgForRepository(secrets, selection.repo);
	}
}

async function filterForReposWithChanges(repos: GitRepository[]) {
	const reposWithChanges: GitRepository[] = [];

	// Check which repositories have changes
	for (const repo of repos) {
		try {
			const gitDiff = await getGitDiff(repo.rootUri.fsPath);
			if (gitDiff) {
				reposWithChanges.push(repo);
			}
		} catch {
			// Skip repositories with errors (no changes, etc.)
		}
	}
	return reposWithChanges;
}

async function promptRepoSelection(repos: GitRepository[]) {
	// Multiple repos with changes - ask user to choose
	const repoItems: Array<vscode.QuickPickItem & { repo: GitRepository | null }> = repos.map((repo) => ({
		label: repo.rootUri.fsPath.split(path.sep).pop() || repo.rootUri.fsPath,
		description: repo.rootUri.fsPath,
		repo: repo,
	}));

	repoItems.unshift({
		label: "$(git-commit) Generate for all repositories with changes",
		description: `Generate commit messages for ${repos.length} repositories`,
		repo: null,
	});

	return await vscode.window.showQuickPick(repoItems, {
		placeHolder: "Select repository for commit message generation",
	});
}

async function generateCommitMsgForRepository(secrets: vscode.SecretStorage, repository: GitRepository) {
	const inputBox = repository.inputBox;
	const repoPath = repository.rootUri.fsPath;
	const gitDiff = await getGitDiff(repoPath);

	if (!gitDiff) {
		throw new Error(`No changes in repository ${repoPath.split(path.sep).pop() || "repository"} for commit message`);
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
			title: `Generating commit message for ${repoPath.split(path.sep).pop() || "repository"}...`,
			cancellable: true,
		},
		(_progress, token) => performCommitMsgGeneration(secrets, gitDiff, inputBox, token)
	);
}

async function performCommitMsgGeneration(
	secrets: vscode.SecretStorage,
	gitDiff: string,
	inputBox: GitRepository["inputBox"],
	token?: vscode.CancellationToken
) {
	const startTime = Date.now();
	let modelId: string | undefined;
	// Per-generation controller: a module-level singleton meant two concurrent
	// generations (or a leftover from a finished run) aborted each other. The
	// progress notification's Cancel button and the SCM stop command both abort it.
	const generationController = new AbortController();
	commitGenerationAbortControllers.add(generationController);
	const cancelSub = token?.onCancellationRequested(() => generationController.abort());
	try {
		vscode.commands.executeCommand("setContext", "customcopilot.isGeneratingCommit", true);
		const config = vscode.workspace.getConfiguration();

		// Get custom prompts or use defaults
		const customSystemPrompt = config.get<string>("customcopilot.commitMessagePrompt", "");
		const PROMPT = {
			system: customSystemPrompt || DEFAULT_PROMPT.system,
			user: DEFAULT_PROMPT.user,
		};

		const prompts: string[] = [];

		const currentInput = inputBox.value?.trim() || "";
		if (currentInput) {
			prompts.push(PROMPT.user.replace("{{USER_CURRENT_INPUT}}", currentInput));
		}

		const truncatedDiff =
			gitDiff.length > 5000 ? gitDiff.substring(0, 5000) + "\n\n[Diff truncated due to size]" : gitDiff;
		prompts.push(truncatedDiff);
		const prompt = prompts.join("\n\n");

		// Get user models from configuration
		const userModels = normalizeUserModels(config.get<unknown>("customcopilot.models", []));

		// Filter models that are marked for commit generation
		const commitModels = userModels.filter((model: CustomModelItem) => model.useForCommitGeneration === true);

		if (commitModels.length === 0) {
			throw new Error(
				"No models configured for commit message generation. Please set 'useForCommitGeneration' to true for at least one model in your configuration."
			);
		}

		// Use the first model marked for commit generation
		const selectedModel = commitModels[0];
		modelId = selectedModel.id;
		logger.info("commit.start", { modelId });

		// Get API key for the model's provider
		const proxyUrl = resolveProxyUrl(selectedModel.proxyUrl, config.get<string>("customcopilot.proxyUrl", ""));
		const apiMode = selectedModel.apiMode ?? "openai";
		const apiKeys = await resolveApiKeys(secrets, selectedModel.owned_by, proxyUrl);
		if (apiKeys.length === 0) {
			throw new Error("API key not configured");
		}
		const normalizedProvider = selectedModel.owned_by.trim().toLowerCase();
		const apiKey = keyBalancer.selectKey(normalizedProvider, apiKeys);

		// Get base URL for the model
		const baseUrl = selectedModel.baseUrl || "";
		if (!baseUrl || !baseUrl.startsWith("http")) {
			throw new Error(`Invalid base URL configuration.`);
		}

		// Get commit language configuration
		const commitLanguage = config.get<string>("customcopilot.commitLanguage", "English");

		// Create a system prompt with language instruction
		const systemPrompt = PROMPT.system + ` Generate commit message in ${commitLanguage}.`;

		// Create a message for the API
		const messages = [{ role: "user", content: prompt }];

		// Create API instance based on model's API mode
		let apiInstance;

		if (apiMode === "anthropic" || apiMode === "zai") {
			apiInstance = new AnthropicApi(modelId);
		} else if (apiMode === "ollama") {
			apiInstance = new OllamaApi(modelId);
		} else if (apiMode === "openai-responses") {
			apiInstance = new OpenaiResponsesApi(modelId);
		} else if (apiMode === "gemini") {
			apiInstance = new GeminiApi(modelId, new Map());
		} else {
			// Default to OpenAI-compatible API
			apiInstance = new OpenaiApi(modelId);
		}

		generationController.signal.throwIfAborted();
		// The signal aborts the HTTP request itself; additionally race each chunk
		// against it so a stalled read can't keep the UI waiting.
		const stream = apiInstance.createMessage(
			selectedModel,
			systemPrompt,
			messages,
			baseUrl,
			apiKey,
			generationController.signal
		);
		const abortPromise = new Promise<never>((_resolve, reject) => {
			const onAbort = () => reject(new Error("Commit message generation cancelled"));
			if (generationController.signal.aborted) {
				onAbort();
			} else {
				generationController.signal.addEventListener("abort", onAbort, { once: true });
			}
		});
		// Avoid an unhandled rejection when the stream finishes before any abort.
		abortPromise.catch(() => undefined);

		let response = "";
		try {
			while (true) {
				const next = await Promise.race([stream.next(), abortPromise]);
				if (next.done) {
					break;
				}
				const chunk = next.value;
				if (chunk.type === "text") {
					response += chunk.text;
					inputBox.value = extractCommitMessage(response);
				}
			}
			keyBalancer.reportSuccess(normalizedProvider, apiKey);
		} catch (err) {
			if (!generationController.signal.aborted) {
				keyBalancer.reportError(normalizedProvider, apiKey, {
					message: err instanceof Error ? err.message : String(err),
				});
			}
			throw err;
		} finally {
			// Fire-and-forget: closing a generator suspended on a pending read
			// would otherwise block until that read settles.
			void stream.return(undefined).catch(() => undefined);
		}

		inputBox.value = removeThinkTags(inputBox.value);

		if (!inputBox.value) {
			throw new Error("empty API response");
		}

		logger.info("commit.end", { modelId, durationMs: Date.now() - startTime });
	} catch (error) {
		if (generationController.signal.aborted) {
			// Don't leave a half-streamed message (possibly with an open
			// <think> block) in the input box.
			inputBox.value = removeThinkTags(inputBox.value ?? "");
			logger.info("commit.cancelled", { modelId: modelId ?? "unknown", durationMs: Date.now() - startTime });
			return;
		}
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("commit.error", { modelId: modelId ?? "unknown", error: errorMessage });
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`);
	} finally {
		cancelSub?.dispose();
		commitGenerationAbortControllers.delete(generationController);
		if (commitGenerationAbortControllers.size === 0) {
			vscode.commands.executeCommand("setContext", "customcopilot.isGeneratingCommit", false);
		}
	}
}

export function abortCommitGeneration() {
	for (const controller of commitGenerationAbortControllers) {
		controller.abort();
	}
	vscode.commands.executeCommand("setContext", "customcopilot.isGeneratingCommit", false);
}

/**
 * Extracts the commit message from the AI response
 * @param str String containing the AI response
 * @returns The extracted commit message
 */
function extractCommitMessage(str: string): string {
	// Remove any markdown formatting or extra text
	return str
		.trim()
		.replace(/^```[^\n]*\n?|```$/g, "")
		.trim();
}

function removeThinkTags(text: string): string {
	// Closed blocks, then an unterminated one (cancelled / truncated stream).
	return text
		.replace(/<think>.*?<\/think>/gs, "")
		.replace(/<think>[\s\S]*$/, "")
		.trim();
}

/**
 * Resolve the pool of API keys for a provider, mirroring the chat provider:
 * a configured remote key source (`customcopilot.apiKeySource.<provider>`) wins,
 * falling back to the inline secret, which may hold several newline-separated
 * keys. Never returns a raw multi-line secret as a single key.
 * @param provider provider name to get provider-specific API keys.
 * @param proxyUrl proxy applied when the remote source is an HTTP(S) URL.
 */
async function resolveApiKeys(secrets: vscode.SecretStorage, provider: string, proxyUrl?: string): Promise<string[]> {
	if (!provider || provider.trim() === "") {
		return [];
	}
	const normalizedProvider = provider.trim().toLowerCase();
	const source = await secrets.get(`customcopilot.apiKeySource.${normalizedProvider}`);
	if (source && source.trim()) {
		const remoteKeys = await resolveApiKeysFromSource(source, { proxyUrl });
		if (remoteKeys.length > 0) {
			return remoteKeys;
		}
	}
	let inline = await secrets.get(`customcopilot.apiKey.${normalizedProvider}`);
	if (!inline && provider.trim() !== normalizedProvider) {
		// Legacy mixed-case secret key (migrated by the chat provider on read).
		inline = await secrets.get(`customcopilot.apiKey.${provider.trim()}`);
	}
	return parseApiKeys(inline ?? "");
}
