/* global acquireVsCodeApi */
"use strict";

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
	/** All HFModelItem[] from backend */
	models: [],
	/** provider name → API key */
	providerKeys: {},
	/** Currently selected provider name, or null = general state */
	selectedProvider: null,
	/** True while adding a new provider */
	isNewProvider: false,
	/** Name of a provider being saved for the first time (to auto-select after init) */
	pendingNewProvider: null,
	/** Models fetched from /models endpoint, pending import selection */
	fetchedModels: [],
	/** True while fetch for panel is in progress */
	isFetchingForPanel: false,
	/** Commit settings */
	commitModel: "",
	commitLanguage: "English",
	/** Selected model ids for bulk delete */
	selectedModelIds: new Set(),
};

const pendingConfirmations = new Map();

// ── DOM refs ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const el = {
	// Sidebar
	providerList:        $("providerList"),
	addProviderBtn:      $("addProviderBtn"),
	exportConfig:        $("exportConfig"),
	importConfig:        $("importConfig"),
	// Empty / general
	emptyState:          $("emptyState"),
	commitModel:         $("commitModel"),
	commitLanguage:      $("commitLanguage"),
	saveCommitBtn:       $("saveCommitBtn"),
	allowAnonymousAccess: $("allowAnonymousAccess"),
	restoreChatSessions: $("restoreChatSessions"),
	telemetryDisabled:   $("telemetryDisabled"),
	chatRetries:         $("chatRetries"),
	chatRetryInterval:   $("chatRetryInterval"),
	chatRetryJitter:     $("chatRetryJitter"),
	// Chat Generator
	chatGenTemplate:     $("chatGenTemplate"),
	chatGenToken:        $("chatGenToken"),
	chatGenSourceMode:   $("chatGenSourceMode"),
	chatGenSimpleRow:    $("chatGenSimpleRow"),
	chatGenSimpleValues: $("chatGenSimpleValues"),
	chatGenAdvancedRow:  $("chatGenAdvancedRow"),
	chatGenJsonl:        $("chatGenJsonl"),
	chatGenMode:         $("chatGenMode"),
	chatGenModel:        $("chatGenModel"),
	chatGenStrategy:     $("chatGenStrategy"),
	chatGenDelayField:   $("chatGenDelayField"),
	chatGenDelay:        $("chatGenDelay"),
	chatGenPreviewBtn:   $("chatGenPreviewBtn"),
	chatGenLaunchBtn:    $("chatGenLaunchBtn"),
	chatGenPreview:      $("chatGenPreview"),
	chatGenPreviewList:  $("chatGenPreviewList"),
	chatGenCount:        $("chatGenCount"),
	// Provider detail
	providerDetail:      $("providerDetail"),
	providerTitle:       $("providerTitle"),
	providerNameField:   $("providerNameField"),
	pName:               $("pName"),
	pBaseUrl:            $("pBaseUrl"),
	pApiKey:             $("pApiKey"),
	pApiMode:            $("pApiMode"),
	pProxyUrl:           $("pProxyUrl"),
	pUserAgent:          $("pUserAgent"),
	pUserAgentPreset:    $("pUserAgentPreset"),
	pUserAgentRandom:    $("pUserAgentRandom"),
	pDelay:              $("pDelay"),
	pHeaders:            $("pHeaders"),
	pPreset:             $("pPreset"),
	keyStatsTable:       $("keyStatsTable"),
	keyStatsBody:        $("keyStatsBody"),
	refreshKeyStatsBtn:  $("refreshKeyStatsBtn"),
	saveProviderBtn:     $("saveProviderBtn"),
	deleteProviderBtn:   $("deleteProviderBtn"),
	// Models section
	modelsSection:       $("modelsSection"),
	modelCount:          $("modelCount"),
	fetchFromApiBtn:     $("fetchFromApiBtn"),
	addModelBtn:         $("addModelBtn"),
	fetchPanel:          $("fetchPanel"),
	fetchStatus:         $("fetchStatus"),
	keyTestStatus:       $("keyTestStatus"),
	fetchResults:        $("fetchResults"),
	selectAllFetched:    $("selectAllFetched"),
	deselectAllFetched:  $("deselectAllFetched"),
	importFetchedBtn:    $("importFetchedBtn"),
	importCount:         $("importCount"),
	cancelFetchBtn:      $("cancelFetchBtn"),
	modelCardsContainer: $("modelCardsContainer"),
	bulkDeleteBar:       $("bulkDeleteBar"),
	bulkDeleteCount:     $("bulkDeleteCount"),
	bulkDeleteBtn:       $("bulkDeleteBtn"),
	bulkSelectAllBtn:    $("bulkSelectAllBtn"),
	bulkClearSelectionBtn: $("bulkClearSelectionBtn"),
	modelFormSection:    $("modelFormSection"),
	modelFormTitle:      $("modelFormTitle"),
	modelError:          $("modelError"),
	// Model form
	modelIdInput:              $("modelIdInput"),
	modelIdDropdown:           $("modelIdDropdown"),
	modelDisplayName:          $("modelDisplayName"),
	modelConfigId:             $("modelConfigId"),
	modelContextLength:        $("modelContextLength"),
	modelMaxTokens:            $("modelMaxTokens"),
	modelMaxCompletionTokens:  $("modelMaxCompletionTokens"),
	modelVision:               $("modelVision"),
	modelTools:                $("modelTools"),
	modelDelay:                $("modelDelay"),
	modelTemperature:          $("modelTemperature"),
	modelTopP:                 $("modelTopP"),
	modelFamily:               $("modelFamily"),
	modelTopK:                 $("modelTopK"),
	modelMinP:                 $("modelMinP"),
	modelFrequencyPenalty:     $("modelFrequencyPenalty"),
	modelPresencePenalty:      $("modelPresencePenalty"),
	modelRepetitionPenalty:    $("modelRepetitionPenalty"),
	modelReasoningEffort:      $("modelReasoningEffort"),
	modelEnableThinking:       $("modelEnableThinking"),
	modelThinkingBudget:       $("modelThinkingBudget"),
	modelIncludeReasoning:     $("modelIncludeReasoning"),
	modelThinkingType:         $("modelThinkingType"),
	modelReasoningEnabled:     $("modelReasoningEnabled"),
	modelReasoningEffortOR:    $("modelReasoningEffortOR"),
	modelReasoningExclude:     $("modelReasoningExclude"),
	modelReasoningMaxTokens:   $("modelReasoningMaxTokens"),
	modelHeaders:              $("modelHeaders"),
	modelExtra:                $("modelExtra"),
	advancedContent:           $("advancedSettingsContent"),
	toggleAdvanced:            $("toggleAdvancedSettings"),
	toggleAdvancedLabel:       $("toggleAdvancedLabel"),
};

const dropdownContent = el.modelIdDropdown.querySelector(".dropdown-content");
const dropdownHeader  = el.modelIdDropdown.querySelector(".dropdown-header");

// ── Provider presets (default API endpoints) ────────────────────────────────────

const PROVIDER_PRESETS = [
	{ label: "OpenAI",                 provider: "openai",      baseUrl: "https://api.openai.com/v1",                       apiMode: "openai" },
	{ label: "Anthropic (Claude)",     provider: "anthropic",   baseUrl: "https://api.anthropic.com/v1",                    apiMode: "anthropic" },
	{ label: "Google Gemini",          provider: "google",      baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiMode: "gemini" },
	{ label: "DeepSeek",               provider: "deepseek",    baseUrl: "https://api.deepseek.com/v1",                     apiMode: "openai" },
	{ label: "OpenRouter",             provider: "openrouter",  baseUrl: "https://openrouter.ai/api/v1",                    apiMode: "openai" },
	{ label: "Groq",                   provider: "groq",        baseUrl: "https://api.groq.com/openai/v1",                  apiMode: "openai" },
	{ label: "Mistral AI",             provider: "mistral",     baseUrl: "https://api.mistral.ai/v1",                       apiMode: "openai" },
	{ label: "xAI (Grok)",             provider: "xai",         baseUrl: "https://api.x.ai/v1",                             apiMode: "openai" },
	{ label: "Together AI",            provider: "together",    baseUrl: "https://api.together.xyz/v1",                     apiMode: "openai" },
	{ label: "Fireworks AI",           provider: "fireworks",   baseUrl: "https://api.fireworks.ai/inference/v1",           apiMode: "openai" },
	{ label: "Perplexity",             provider: "perplexity",  baseUrl: "https://api.perplexity.ai",                       apiMode: "openai" },
	{ label: "Cerebras",               provider: "cerebras",    baseUrl: "https://api.cerebras.ai/v1",                      apiMode: "openai" },
	{ label: "Moonshot (Kimi)",        provider: "moonshot",    baseUrl: "https://api.moonshot.cn/v1",                      apiMode: "openai" },
	{ label: "ModelScope",             provider: "modelscope",  baseUrl: "https://api-inference.modelscope.cn/v1",          apiMode: "openai" },
	{ label: "SiliconFlow",            provider: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1",                   apiMode: "openai" },
	{ label: "Novita AI",              provider: "novita",      baseUrl: "https://api.novita.ai/v3/openai",                 apiMode: "openai" },
	{ label: "Alibaba (Qwen/DashScope)", provider: "qwen",      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiMode: "openai" },
	{ label: "Zhipu (GLM)",            provider: "zhipu",       baseUrl: "https://open.bigmodel.cn/api/paas/v4",            apiMode: "openai" },
	{ label: "Ollama (local)",         provider: "ollama",      baseUrl: "http://localhost:11434",                          apiMode: "ollama" },
	{ label: "LM Studio (local)",      provider: "lmstudio",    baseUrl: "http://localhost:1234/v1",                        apiMode: "openai" },
	{ label: "Z.AI Free (Claude-compatible)", provider: "zai", baseUrl: "https://api.z.ai/api/anthropic",                 apiMode: "zai" },
];

function populateProviderPresets() {
	if (!el.pPreset) {
		return;
	}
	// Keep the first placeholder option, append presets.
	while (el.pPreset.children.length > 1) {
		el.pPreset.removeChild(el.pPreset.lastChild);
	}
	PROVIDER_PRESETS.forEach((preset, idx) => {
		const opt = document.createElement("option");
		opt.value = String(idx);
		opt.textContent = preset.label;
		el.pPreset.appendChild(opt);
	});
}

populateProviderPresets();

el.pPreset?.addEventListener("change", () => {
	const idx = parseInt(el.pPreset.value, 10);
	if (Number.isNaN(idx) || !PROVIDER_PRESETS[idx]) {
		return;
	}
	const preset = PROVIDER_PRESETS[idx];
	el.pBaseUrl.value = preset.baseUrl;
	el.pApiMode.value = preset.apiMode;
	// Only prefill the provider id field when creating a new provider and it's empty.
	if (state.isNewProvider && el.pName && !el.pName.value.trim()) {
		el.pName.value = preset.provider;
	}
	// Reset selection back to placeholder so the same preset can be re-applied.
	el.pPreset.value = "";
});

// ── User-Agent presets ─────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

const USER_AGENT_PRESETS = [
	{ label: "Firefox · Windows",  value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0" },
	{ label: "Firefox · Linux",    value: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
	{ label: "Firefox · macOS",    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0" },
	{ label: "Chrome · Windows",   value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
	{ label: "Chrome · Linux",     value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
	{ label: "Chrome · macOS",     value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" },
	{ label: "Edge · Windows",     value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0" },
	{ label: "Safari · macOS",     value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15" },
	{ label: "Chrome · Android",   value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36" },
	{ label: "Safari · iOS",       value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1" },
];

function populateUserAgentPresets() {
	if (!el.pUserAgentPreset) {
		return;
	}
	while (el.pUserAgentPreset.children.length > 1) {
		el.pUserAgentPreset.removeChild(el.pUserAgentPreset.lastChild);
	}
	USER_AGENT_PRESETS.forEach((preset, idx) => {
		const opt = document.createElement("option");
		opt.value = String(idx);
		opt.textContent = preset.label;
		el.pUserAgentPreset.appendChild(opt);
	});
}

populateUserAgentPresets();

el.pUserAgentPreset?.addEventListener("change", () => {
	const idx = parseInt(el.pUserAgentPreset.value, 10);
	if (Number.isNaN(idx) || !USER_AGENT_PRESETS[idx]) {
		return;
	}
	el.pUserAgent.value = USER_AGENT_PRESETS[idx].value;
	// Reset back to placeholder so the same preset can be re-applied.
	el.pUserAgentPreset.value = "";
});

el.pUserAgentRandom?.addEventListener("click", () => {
	const idx = Math.floor(Math.random() * USER_AGENT_PRESETS.length);
	el.pUserAgent.value = USER_AGENT_PRESETS[idx].value;
});

// ── Provider data helpers ──────────────────────────────────────────────────────

function getProviders() {
	return [...new Set(state.models.map((m) => m.owned_by).filter(Boolean))].sort();
}

function getProviderInfo(name) {
	const models = state.models.filter((m) => m.owned_by === name);
	const placeholder = models.find((m) => m.id.startsWith("__provider__"));
	const first = placeholder || models[0];
	return {
		baseUrl:   first?.baseUrl   ?? "",
		proxyUrl:  first?.proxyUrl  ?? "",
		userAgent: first?.userAgent ?? "",
		apiMode:   first?.apiMode   ?? "openai",
		headers:   first?.headers,
		delay:     first?.delay,
		apiKey:    state.providerKeys[name] ?? "",
	};
}

function getProviderModels(name) {
	return state.models.filter((m) => m.owned_by === name && !m.id.startsWith("__provider__"));
}

// ── API key health table ───────────────────────────────────────────────────────

// Mirror of parseApiKeys() in src/keyBalancer.ts: split on newlines/commas,
// trim, drop empties and duplicates — keeps row order in sync with the backend.
function parseRawKeys(raw) {
	if (!raw) { return []; }
	const seen = new Set();
	const out = [];
	for (const part of String(raw).split(/[\r\n,]+/)) {
		const key = part.trim();
		if (key && !seen.has(key)) {
			seen.add(key);
			out.push(key);
		}
	}
	return out;
}

function requestKeyStats(name) {
	if (!name || name === "git-commit" || name === "__global__") {
		clearKeyStats();
		return;
	}
	vscode.postMessage({ type: "requestKeyStats", provider: name });
}

function clearKeyStats() {
	if (!el.keyStatsBody) { return; }
	el.keyStatsBody.innerHTML =
		'<tr class="key-stats-empty"><td colspan="4">No API keys configured.</td></tr>';
}

function renderKeyStats(provider, stats) {
	if (!el.keyStatsBody) { return; }
	// Ignore late responses for a provider that is no longer selected.
	if (provider !== state.selectedProvider) { return; }
	if (!stats || !stats.length) {
		clearKeyStats();
		return;
	}
	// The backend returns masked keys in the same order as the stored keys, so
	// we can recover each full key (kept in memory in state.providerKeys) by
	// index to surface it as a hover tooltip.
	const fullKeys = parseRawKeys(state.providerKeys[provider]);
	el.keyStatsBody.innerHTML = stats.map((s, i) => {
		const hasErrors = s.errors > 0;
		const statusLabel = s.benched
			? '<span class="ks-badge ks-benched" title="Temporarily benched after repeated failures">Benched</span>'
			: hasErrors
				? '<span class="ks-badge ks-warn">OK</span>'
				: '<span class="ks-badge ks-ok">OK</span>';
		const lastError = s.lastError ? ` title="Last error: ${escAttr(s.lastError)}"` : "";
		const fullKey = fullKeys[i];
		const keyTitle = fullKey ? ` title="${escAttr(fullKey)}"` : "";
		return `<tr class="${hasErrors ? "ks-has-errors" : ""}"${lastError}>
			<td class="ks-key"><span class="ks-key-text"${keyTitle}>${escHtml(s.keyMasked)}</span></td>
			<td class="ks-num">${s.requests}</td>
			<td class="ks-num${hasErrors ? " ks-num-error" : ""}">${s.errors}</td>
			<td class="ks-status">${statusLabel}</td>
		</tr>`;
	}).join("");
}

el.refreshKeyStatsBtn?.addEventListener("click", () => {
	requestKeyStats(state.selectedProvider);
});

// ── Sidebar rendering ──────────────────────────────────────────────────────────

function renderSidebar() {
	const providers = getProviders();
	let html = "";
	if (!providers.length) {
		html += '<div class="no-providers">No providers yet</div>';
	} else {
		html += providers.map((name) => {
			const count  = getProviderModels(name).length;
			const hasKey = !!state.providerKeys[name];
			const active = !state.isNewProvider && state.selectedProvider === name;
			return `<div class="provider-item${active ? " active" : ""}" data-provider="${escAttr(name)}">
				<span class="provider-item-name">${escHtml(name)}</span>
				<span class="provider-item-meta">
					<span class="badge">${count}</span>
					<span class="key-icon" title="${hasKey ? "API key set" : "No API key"}">${hasKey ? "🔑" : "🔒"}</span>
				</span>
			</div>`;
		}).join("");
	}

	const gitActive = !state.isNewProvider && state.selectedProvider === "git-commit";
	html += `<div class="provider-item-separator"></div>`;
	html += `<div class="provider-item special-item${gitActive ? " active" : ""}" data-special="git-commit">
		<span class="provider-item-name">⚙️ Git Commit Settings</span>
	</div>`;

	const integrationActive = !state.isNewProvider && state.selectedProvider === "integration";
	html += `<div class="provider-item special-item${integrationActive ? " active" : ""}" data-special="integration">
		<span class="provider-item-name">🌐 Global Settings</span>
	</div>`;

	const chatGenActive = !state.isNewProvider && state.selectedProvider === "chatgen";
	html += `<div class="provider-item special-item${chatGenActive ? " active" : ""}" data-special="chatgen">
		<span class="provider-item-name">⚡ Chat Generator</span>
	</div>`;

	el.providerList.innerHTML = html;

	el.providerList.querySelectorAll(".provider-item[data-provider]").forEach((item) => {
		item.addEventListener("click", () => selectProvider(item.getAttribute("data-provider")));
	});

	el.providerList.querySelectorAll(".provider-item[data-special='git-commit']").forEach((item) => {
		item.addEventListener("click", selectGitCommitSettings);
	});

	el.providerList.querySelectorAll(".provider-item[data-special='integration']").forEach((item) => {
		item.addEventListener("click", selectIntegrationSettings);
	});

	el.providerList.querySelectorAll(".provider-item[data-special='chatgen']").forEach((item) => {
		item.addEventListener("click", selectChatGenSettings);
	});
}

// ── Navigation ─────────────────────────────────────────────────────────────────

function showEmptyState() {
	state.selectedProvider = null;
	state.isNewProvider = false;
	clearModelSelection();
	renderSidebar();
	el.emptyState.style.display = "";
	el.providerDetail.style.display = "none";

	// Restore default empty hint view for widescreen
	const hint = $("emptyHintText");
	if (hint) {
		hint.style.display = "";
	}
	const backBar = $("gitCommitBackBar");
	if (backBar) {
		backBar.style.display = "none";
	}
	const commitSection = $("commitSection");
	if (commitSection) {
		commitSection.style.display = "";
	}
	const integrationSection = $("integrationSection");
	if (integrationSection) {
		integrationSection.style.display = "";
	}
	const chatGenSection = $("chatGenSection");
	if (chatGenSection) {
		chatGenSection.style.display = "";
	}

	updateActiveScreen();
}

function selectProvider(name) {
	state.selectedProvider = name;
	state.isNewProvider = false;
	clearModelSelection();
	renderSidebar();

	el.emptyState.style.display = "none";
	el.providerDetail.style.display = "";

	// Heading: show title, hide name input
	el.providerTitle.textContent = name;
	el.providerTitle.style.display = "";
	el.providerNameField.style.display = "none";
	el.deleteProviderBtn.style.display = "";

	// Fill provider settings
	const info = getProviderInfo(name);
	el.pBaseUrl.value   = info.baseUrl;
	el.pApiKey.value    = info.apiKey;
	el.pApiMode.value   = info.apiMode;
	el.pProxyUrl.value  = info.proxyUrl;
	el.pUserAgent.value = info.userAgent;
	el.pDelay.value     = info.delay != null ? info.delay : "";
	el.pHeaders.value   = info.headers ? JSON.stringify(info.headers, null, 2) : "";

	// Show models section
	el.modelsSection.style.display = "";
	hideFetchPanel();
	hideModelForm();
	renderModelTable(name);

	requestKeyStats(name);

	updateActiveScreen();
}

function showNewProviderForm() {
	state.selectedProvider = null;
	state.isNewProvider = true;
	clearModelSelection();
	renderSidebar();

	el.emptyState.style.display = "none";
	el.providerDetail.style.display = "";

	// Heading: hide title, show name input
	el.providerTitle.style.display = "none";
	el.providerNameField.style.display = "";
	el.pName.value = "";
	el.deleteProviderBtn.style.display = "none";

	// Clear all fields
	el.pBaseUrl.value = "";
	el.pApiKey.value  = "";
	el.pApiMode.value = "openai";
	el.pProxyUrl.value  = "";
	el.pUserAgent.value = DEFAULT_USER_AGENT;
	el.pDelay.value     = "";
	el.pHeaders.value   = "";

	// Hide models section for new providers (created on save)
	el.modelsSection.style.display = "none";
	clearKeyStats();
	el.pName.focus();

	updateActiveScreen();
}

function selectGitCommitSettings() {
	state.selectedProvider = "git-commit";
	state.isNewProvider = false;
	clearModelSelection();
	renderSidebar();

	// Show emptyState and hide provider details
	el.emptyState.style.display = "";
	el.providerDetail.style.display = "none";

	// Hide the emptyState hint, and show the back button bar
	const hint = $("emptyHintText");
	if (hint) {
		hint.style.display = "none";
	}
	const backBar = $("gitCommitBackBar");
	if (backBar) {
		backBar.style.display = "flex";
	}
	const commitSection = $("commitSection");
	if (commitSection) {
		commitSection.style.display = "";
	}
	const integrationSection = $("integrationSection");
	if (integrationSection) {
		integrationSection.style.display = "none";
	}
	const chatGenSection = $("chatGenSection");
	if (chatGenSection) {
		chatGenSection.style.display = "none";
	}

	updateActiveScreen();
}

function selectIntegrationSettings() {
	state.selectedProvider = "integration";
	state.isNewProvider = false;
	clearModelSelection();
	renderSidebar();

	// Show emptyState and hide provider details
	el.emptyState.style.display = "";
	el.providerDetail.style.display = "none";

	// Hide the emptyState hint, and show the back button bar
	const hint = $("emptyHintText");
	if (hint) {
		hint.style.display = "none";
	}
	const backBar = $("gitCommitBackBar");
	if (backBar) {
		backBar.style.display = "flex";
	}
	const commitSection = $("commitSection");
	if (commitSection) {
		commitSection.style.display = "none";
	}
	const integrationSection = $("integrationSection");
	if (integrationSection) {
		integrationSection.style.display = "";
	}
	const chatGenSection = $("chatGenSection");
	if (chatGenSection) {
		chatGenSection.style.display = "none";
	}

	updateActiveScreen();
}

function selectChatGenSettings() {
	state.selectedProvider = "chatgen";
	state.isNewProvider = false;
	clearModelSelection();
	renderSidebar();

	el.emptyState.style.display = "";
	el.providerDetail.style.display = "none";

	const hint = $("emptyHintText");
	if (hint) {
		hint.style.display = "none";
	}
	const backBar = $("gitCommitBackBar");
	if (backBar) {
		backBar.style.display = "flex";
	}
	const commitSection = $("commitSection");
	if (commitSection) {
		commitSection.style.display = "none";
	}
	const integrationSection = $("integrationSection");
	if (integrationSection) {
		integrationSection.style.display = "none";
	}
	const chatGenSection = $("chatGenSection");
	if (chatGenSection) {
		chatGenSection.style.display = "";
	}

	populateChatGenModelDropdown();
	updateActiveScreen();
}

function updateActiveScreen() {
	const layout = document.querySelector(".layout");
	if (!layout) {
		return;
	}

	// Reset screen classes
	layout.classList.remove("screen-list", "screen-provider-detail", "screen-git-commit");

	if (state.selectedProvider === "git-commit") {
		layout.classList.add("screen-git-commit");
	} else if (state.selectedProvider === "integration") {
		layout.classList.add("screen-git-commit");
	} else if (state.selectedProvider === "chatgen") {
		layout.classList.add("screen-git-commit");
	} else if (state.selectedProvider !== null || state.isNewProvider) {
		layout.classList.add("screen-provider-detail");
	} else {
		layout.classList.add("screen-list");
	}
}

// ── Provider actions ───────────────────────────────────────────────────────────

el.addProviderBtn.addEventListener("click", showNewProviderForm);
$("backToHomeBtn").addEventListener("click", showEmptyState);
$("gitCommitBackBtn").addEventListener("click", showEmptyState);
el.exportConfig.addEventListener("click", () => vscode.postMessage({ type: "exportConfig" }));
el.importConfig.addEventListener("click", () => vscode.postMessage({ type: "importConfig" }));

el.saveProviderBtn.addEventListener("click", () => {
	if (state.isNewProvider) {
		const name = el.pName.value.trim();
		if (!name) { showProviderError("Provider ID is required."); return; }
		state.pendingNewProvider = name;
		vscode.postMessage({
			type:      "addProvider",
			provider:  name,
			baseUrl:   el.pBaseUrl.value.trim()   || undefined,
			apiKey:    el.pApiKey.value.trim()    || undefined,
			apiMode:   el.pApiMode.value          || undefined,
			proxyUrl:  el.pProxyUrl.value.trim()  || undefined,
			userAgent: el.pUserAgent.value.trim() || undefined,
			delay:     numOrUndef(el.pDelay.value),
			headers:   parseJson(el.pHeaders.value),
		});
	} else if (state.selectedProvider) {
		vscode.postMessage({
			type:      "updateProvider",
			provider:  state.selectedProvider,
			baseUrl:   el.pBaseUrl.value.trim()   || undefined,
			apiKey:    el.pApiKey.value.trim()    || undefined,
			apiMode:   el.pApiMode.value          || undefined,
			proxyUrl:  el.pProxyUrl.value.trim()  || undefined,
			userAgent: el.pUserAgent.value.trim() || undefined,
			delay:     numOrUndef(el.pDelay.value),
			headers:   parseJson(el.pHeaders.value),
		});
	}
});

el.deleteProviderBtn.addEventListener("click", () => {
	if (!state.selectedProvider) return;
	const id = `delProv_${Date.now()}`;
	pendingConfirmations.set(id, {
		action: () => vscode.postMessage({ type: "deleteProvider", provider: state.selectedProvider }),
	});
	vscode.postMessage({
		type:    "requestConfirm",
		id,
		message: `Delete provider "${state.selectedProvider}" and all its models?`,
		action:  "deleteProvider",
	});
});

function showProviderError(msg) {
	// Use VS Code showErrorMessage via postMessage isn't available; alert is acceptable
	console.error("[customcopilot] Provider error:", msg);
}

// ── Commit settings ────────────────────────────────────────────────────────────

el.saveCommitBtn.addEventListener("click", () => {
	vscode.postMessage({
		type:           "saveCommitSettings",
		commitModel:    el.commitModel.value,
		commitLanguage: el.commitLanguage.value,
	});
});

if (el.allowAnonymousAccess) {
	el.allowAnonymousAccess.addEventListener("change", () => {
		vscode.postMessage({
			type:    "setAnonymousAccess",
			enabled: el.allowAnonymousAccess.checked,
		});
	});
}

if (el.restoreChatSessions) {
	el.restoreChatSessions.addEventListener("change", () => {
		vscode.postMessage({
			type:    "setRestoreChatSessions",
			enabled: el.restoreChatSessions.checked,
		});
	});
}

if (el.telemetryDisabled) {
	el.telemetryDisabled.addEventListener("change", () => {
		vscode.postMessage({
			type:     "setTelemetryDisabled",
			disabled: el.telemetryDisabled.checked,
		});
	});
}

if (el.chatRetries) {
	el.chatRetries.addEventListener("change", () => {
		let value = parseInt(el.chatRetries.value, 10);
		if (!Number.isFinite(value) || value < -1) {
			value = 0;
		}
		el.chatRetries.value = String(value);
		vscode.postMessage({ type: "setChatRetries", value });
	});
}

if (el.chatRetryInterval) {
	el.chatRetryInterval.addEventListener("change", () => {
		let value = parseInt(el.chatRetryInterval.value, 10);
		if (!Number.isFinite(value) || value < 0) {
			value = 1000;
		}
		el.chatRetryInterval.value = String(value);
		vscode.postMessage({ type: "setChatRetryInterval", value });
	});
}

if (el.chatRetryJitter) {
	el.chatRetryJitter.addEventListener("change", () => {
		let value = parseInt(el.chatRetryJitter.value, 10);
		if (!Number.isFinite(value) || value < 0) {
			value = 0;
		}
		el.chatRetryJitter.value = String(value);
		vscode.postMessage({ type: "setChatRetryJitter", value });
	});
}

// ── Chat Generator ───────────────────────────────────────────────────────────

function populateChatGenModelDropdown() {
	if (!el.chatGenModel) {
		return;
	}
	const current = el.chatGenModel.value;
	while (el.chatGenModel.children.length > 1) {
		el.chatGenModel.removeChild(el.chatGenModel.lastChild);
	}
	state.models
		.filter((m) => !m.id.startsWith("__provider__"))
		.sort((a, b) => a.id.localeCompare(b.id))
		.forEach((m) => {
			const fid = m.configId ? `${m.id}::${m.configId}` : m.id;
			const opt = document.createElement("option");
			opt.value = fid;
			opt.textContent = m.displayName || fid;
			el.chatGenModel.appendChild(opt);
		});
	// Restore previous selection if it still exists
	if (current && [...el.chatGenModel.options].some((o) => o.value === current)) {
		el.chatGenModel.value = current;
	}
}

/** Build the list of prompts from the template + replacement source. */
function buildChatGenPrompts() {
	const template = (el.chatGenTemplate?.value ?? "").trim();
	if (!template) {
		return { prompts: [], error: "Add a prompt template first." };
	}

	const sourceMode = el.chatGenSourceMode?.value ?? "simple";

	if (sourceMode === "simple") {
		const token = (el.chatGenToken?.value ?? "[REPLACE_THAT]").trim() || "[REPLACE_THAT]";
		const values = (el.chatGenSimpleValues?.value ?? "")
			.split("\n")
			.map((v) => v.trim())
			.filter((v) => v.length > 0);
		if (values.length === 0) {
			return { prompts: [], error: "Add at least one replacement value (one per line)." };
		}
		const prompts = values.map((v) => template.split(token).join(v));
		return { prompts, error: null };
	}

	// Advanced JSONL mode
	const lines = (el.chatGenJsonl?.value ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) {
		return { prompts: [], error: "Add at least one JSON object (one per line)." };
	}

	const prompts = [];
	for (let i = 0; i < lines.length; i++) {
		let obj;
		try {
			obj = JSON.parse(lines[i]);
		} catch (_e) {
			return { prompts: [], error: `Invalid JSON on line ${i + 1}.` };
		}
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
			return { prompts: [], error: `Line ${i + 1} must be a JSON object.` };
		}
		let prompt = template;
		for (const [key, value] of Object.entries(obj)) {
			prompt = prompt.split(`[${key}]`).join(String(value));
		}
		prompts.push(prompt);
	}
	return { prompts, error: null };
}

function renderChatGenPreview(prompts) {
	if (!el.chatGenPreview || !el.chatGenPreviewList) {
		return;
	}
	el.chatGenCount.textContent = `${prompts.length} prompt${prompts.length === 1 ? "" : "s"}`;
	el.chatGenPreviewList.innerHTML = prompts
		.map(
			(p, idx) => `<div class="chatgen-item">
				<div class="chatgen-item-head">
					<span class="chatgen-item-index">#${idx + 1}</span>
					<div class="chatgen-item-actions">
						<button class="secondary small chatgen-copy-btn" data-idx="${idx}">Copy</button>
						<button class="secondary small chatgen-open-btn" data-idx="${idx}">Open</button>
					</div>
				</div>
				<div class="chatgen-item-text">${escHtml(p)}</div>
			</div>`
		)
		.join("");

	el.chatGenPreviewList.querySelectorAll(".chatgen-copy-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			const idx = parseInt(btn.getAttribute("data-idx"), 10);
			const text = prompts[idx];
			if (navigator.clipboard) {
				navigator.clipboard.writeText(text);
			}
			btn.textContent = "Copied";
			setTimeout(() => (btn.textContent = "Copy"), 1200);
		});
	});

	el.chatGenPreviewList.querySelectorAll(".chatgen-open-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			const idx = parseInt(btn.getAttribute("data-idx"), 10);
			vscode.postMessage({
				type:        "prefillChat",
				prompt:      prompts[idx],
				mode:        el.chatGenMode?.value ?? "agent",
				modelFullId: el.chatGenModel?.value || undefined,
			});
		});
	});

	el.chatGenPreview.style.display = "";
}

if (el.chatGenSourceMode) {
	el.chatGenSourceMode.addEventListener("change", () => {
		const advanced = el.chatGenSourceMode.value === "advanced";
		if (el.chatGenSimpleRow) {
			el.chatGenSimpleRow.style.display = advanced ? "none" : "";
		}
		if (el.chatGenAdvancedRow) {
			el.chatGenAdvancedRow.style.display = advanced ? "" : "none";
		}
		if (el.chatGenToken) {
			el.chatGenToken.parentElement.style.display = advanced ? "none" : "";
		}
	});
}

if (el.chatGenStrategy) {
	el.chatGenStrategy.addEventListener("change", () => {
		if (el.chatGenDelayField) {
			el.chatGenDelayField.style.display = el.chatGenStrategy.value === "parallel" ? "" : "none";
		}
	});
}

if (el.chatGenPreviewBtn) {
	el.chatGenPreviewBtn.addEventListener("click", () => {
		const { prompts, error } = buildChatGenPrompts();
		if (error) {
			vscode.postMessage({ type: "requestConfirm", id: `cg-${Date.now()}`, message: error, action: "showInfo" });
			return;
		}
		renderChatGenPreview(prompts);
	});
}

if (el.chatGenLaunchBtn) {
	el.chatGenLaunchBtn.addEventListener("click", () => {
		const { prompts, error } = buildChatGenPrompts();
		if (error) {
			vscode.postMessage({ type: "requestConfirm", id: `cg-${Date.now()}`, message: error, action: "showInfo" });
			return;
		}
		renderChatGenPreview(prompts);
		const delayMs = parseInt(el.chatGenDelay?.value ?? "1500", 10);
		vscode.postMessage({
			type:        "launchChats",
			prompts,
			mode:        el.chatGenMode?.value ?? "agent",
			modelFullId: el.chatGenModel?.value || undefined,
			strategy:    el.chatGenStrategy?.value === "parallel" ? "parallel" : "sequential",
			delayMs:     Number.isFinite(delayMs) ? delayMs : 1500,
		});
	});
}

function populateCommitModelDropdown() {
	while (el.commitModel.children.length > 1) el.commitModel.removeChild(el.commitModel.lastChild);
	state.models
		.filter((m) => !m.id.startsWith("__provider__"))
		.sort((a, b) => a.id.localeCompare(b.id))
		.forEach((m) => {
			const fid = m.configId ? `${m.id}::${m.configId}` : m.id;
			const opt = document.createElement("option");
			opt.value = fid;
			opt.textContent = m.displayName || fid;
			el.commitModel.appendChild(opt);
		});
}

// ── Model table ────────────────────────────────────────────────────────────────

function renderModelTable(providerName) {
	const models = getProviderModels(providerName).sort((a, b) => a.id.localeCompare(b.id));
	el.modelCount.textContent = models.length;

	const validIds = new Set(models.map((m) => (m.configId ? `${m.id}::${m.configId}` : m.id)));
	state.selectedModelIds = new Set([...state.selectedModelIds].filter((id) => validIds.has(id)));

	if (!models.length) {
		el.modelCardsContainer.innerHTML =
			'<div class="no-data">No models — add manually or fetch from API</div>';
		updateBulkDeleteBar();
		return;
	}

	el.modelCardsContainer.innerHTML = models.map((m) => {
		const mid = m.configId ? `${m.id}::${m.configId}` : m.id;
		const checked = state.selectedModelIds.has(mid);
		const maxOutput = m.max_tokens != null ? m.max_tokens : m.max_completion_tokens != null ? m.max_completion_tokens : null;

		const tags = [];
		if (m.context_length) tags.push(`${fmtNum(m.context_length)} ctx`);
		if (maxOutput) tags.push(`${fmtNum(maxOutput)} max`);
		if (m.vision) tags.push("vision");
		if (m.delay) tags.push(`${m.delay}ms delay`);

		const tagsHtml = tags.map(tag => `<span class="model-badge">${escHtml(tag)}</span>`).join("");

		return `
		<div class="model-card${checked ? " selected" : ""}">
			<div class="model-card-select-row">
				<label class="model-card-select" title="Select for bulk delete">
					<input type="checkbox" class="model-select-checkbox" data-id="${escAttr(mid)}" ${checked ? "checked" : ""} />
					<span>Select</span>
				</label>
			</div>
			<div class="model-card-header">
				<div class="model-card-title-row">
					<div class="model-card-id" title="${escAttr(m.id)}">${escHtml(m.id)}</div>
					${m.configId ? `<div class="model-card-config" title="Config Variant">${escHtml(m.configId)}</div>` : ""}
				</div>
				${m.displayName ? `<div class="model-card-display" title="Display Name">${escHtml(m.displayName)}</div>` : ""}
			</div>
			<div class="model-card-badges">
				${tagsHtml}
			</div>
			<div class="model-card-footer">
				<button class="edit-model-btn secondary small" data-id="${escAttr(mid)}">
					<span class="icon" aria-hidden="true">✎</span> Edit
				</button>
				<button class="delete-model-btn danger small" data-id="${escAttr(mid)}">
					<span class="icon" aria-hidden="true">🗑</span> Delete
				</button>
			</div>
		</div>`;
	}).join("");

	el.modelCardsContainer.querySelectorAll(".model-select-checkbox").forEach((cb) => {
		cb.addEventListener("change", (e) => {
			const id = e.currentTarget.getAttribute("data-id");
			if (!id) {
				return;
			}
			if (e.currentTarget.checked) {
				state.selectedModelIds.add(id);
			} else {
				state.selectedModelIds.delete(id);
			}
			renderModelTable(providerName);
		});
	});

	el.modelCardsContainer.querySelectorAll(".edit-model-btn").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			const mid    = e.currentTarget.getAttribute("data-id");
			const parsed = parseFullModelId(mid);
			const model  = state.models.find(
				(m) => m.id === parsed.baseId &&
					(parsed.configId ? m.configId === parsed.configId : !m.configId)
			);
			if (model) {
				showModelForm(`Edit: ${mid}`);
				populateModelForm(model);
				// Pre-load dropdown for the current provider
				const info = getProviderInfo(model.owned_by || state.selectedProvider);
				vscode.postMessage({
					type:      "fetchModels",
					baseUrl:   model.baseUrl  || info.baseUrl,
					apiKey:    info.apiKey,
					apiMode:   model.apiMode  || info.apiMode,
					proxyUrl:  model.proxyUrl || info.proxyUrl || undefined,
					userAgent: model.userAgent || info.userAgent || undefined,
					headers:   model.headers,
				});
			}
		});
	});

	el.modelCardsContainer.querySelectorAll(".delete-model-btn").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			const mid = e.currentTarget.getAttribute("data-id");
			const id  = `delModel_${Date.now()}`;
			pendingConfirmations.set(id, {
				action: () => vscode.postMessage({ type: "deleteModel", modelId: mid }),
			});
			vscode.postMessage({
				type:    "requestConfirm",
				id,
				message: `Delete model "${mid}"?`,
				action:  "deleteModel",
			});
		});
	});

	updateBulkDeleteBar();
}

function clearModelSelection() {
	state.selectedModelIds = new Set();
	updateBulkDeleteBar();
}

function updateBulkDeleteBar() {
	if (!el.bulkDeleteBar || !el.bulkDeleteCount) {
		return;
	}
	const count = state.selectedModelIds.size;
	el.bulkDeleteCount.textContent = String(count);
	el.bulkDeleteBar.style.display = count > 0 && !!state.selectedProvider ? "flex" : "none";
}

el.bulkClearSelectionBtn?.addEventListener("click", () => {
	clearModelSelection();
	if (state.selectedProvider) {
		renderModelTable(state.selectedProvider);
	}
});

el.bulkSelectAllBtn?.addEventListener("click", () => {
	if (!state.selectedProvider) {
		return;
	}
	const ids = getProviderModels(state.selectedProvider).map((m) => (m.configId ? `${m.id}::${m.configId}` : m.id));
	state.selectedModelIds = new Set(ids);
	renderModelTable(state.selectedProvider);
});

el.bulkDeleteBtn?.addEventListener("click", () => {
	if (!state.selectedProvider || state.selectedModelIds.size === 0) {
		return;
	}
	const selectedIds = [...state.selectedModelIds];
	const id = `bulkDel_${Date.now()}`;
	pendingConfirmations.set(id, {
		action: () => {
			vscode.postMessage({ type: "deleteModels", modelIds: selectedIds });
			clearModelSelection();
		},
	});
	vscode.postMessage({
		type: "requestConfirm",
		id,
		message: `Delete ${selectedIds.length} selected model(s)?`,
		action: "deleteModel",
	});
});

// ── Fetch from API ─────────────────────────────────────────────────────────────

el.fetchFromApiBtn.addEventListener("click", () => {
	if (!state.selectedProvider) return;
	const info = getProviderInfo(state.selectedProvider);

	state.isFetchingForPanel = true;
	state.fetchedModels = [];
	el.fetchPanel.style.display = "";
	el.fetchStatus.textContent = "Fetching models…";
	el.fetchResults.innerHTML  = '<div class="fetch-loading">Loading…</div>';
	if (el.keyTestStatus) {
		el.keyTestStatus.style.display = "none";
		el.keyTestStatus.innerHTML = "";
	}
	el.importFetchedBtn.disabled = true;
	el.importCount.textContent = "0";

	vscode.postMessage({
		type:      "fetchModels",
		baseUrl:   info.baseUrl,
		apiKey:    info.apiKey,
		apiMode:   info.apiMode,
		proxyUrl:  info.proxyUrl  || undefined,
		userAgent: info.userAgent || undefined,
		headers:   info.headers,
	});
});

el.cancelFetchBtn.addEventListener("click", hideFetchPanel);

el.selectAllFetched.addEventListener("click", () => {
	el.fetchResults.querySelectorAll("input[type='checkbox']:not(:disabled)").forEach((cb) => {
		cb.checked = true;
	});
	updateImportCount();
});

el.deselectAllFetched.addEventListener("click", () => {
	el.fetchResults.querySelectorAll("input[type='checkbox']").forEach((cb) => {
		cb.checked = false;
	});
	updateImportCount();
});

el.importFetchedBtn.addEventListener("click", () => {
	const selected = [];
	el.fetchResults.querySelectorAll("input[type='checkbox']:checked").forEach((cb) => {
		const idx = parseInt(cb.dataset.idx, 10);
		if (!isNaN(idx) && state.fetchedModels[idx]) selected.push(state.fetchedModels[idx]);
	});
	if (!selected.length) {
		return;
	}
	vscode.postMessage({
		type:     "importModels",
		models:   selected,
		provider: state.selectedProvider,
	});
	hideFetchPanel();
});

function hideFetchPanel() {
	el.fetchPanel.style.display = "none";
	state.fetchedModels = [];
	state.isFetchingForPanel = false;
	if (el.keyTestStatus) {
		el.keyTestStatus.style.display = "none";
		el.keyTestStatus.innerHTML = "";
	}
}

function updateImportCount() {
	const count = el.fetchResults.querySelectorAll("input[type='checkbox']:checked").length;
	el.importCount.textContent = count;
	el.importFetchedBtn.disabled = count === 0;
}

function showFetchResults(models, keyResults) {
	state.fetchedModels = models;
	state.isFetchingForPanel = false;

	renderKeyTestStatus(keyResults);

	if (!models.length) {
		el.fetchStatus.textContent = "No models returned from API.";
		el.fetchResults.innerHTML = "";
		el.importFetchedBtn.disabled = true;
		return;
	}

	const multiKey = Array.isArray(keyResults) && keyResults.length > 1;
	el.fetchStatus.textContent = multiKey
		? `Found ${models.length} model(s) available on all keys — select to import`
		: `Found ${models.length} model(s) — select to import`;

	const existingIds = new Set(
		getProviderModels(state.selectedProvider).map((m) =>
			m.configId ? `${m.id}::${m.configId}` : m.id
		)
	);

	el.fetchResults.innerHTML = models.map((m, i) => {
		const alreadyAdded = existingIds.has(m.id);
		const checked      = !alreadyAdded;
		const meta = [
			m.context_length ? `${fmtNum(m.context_length)} ctx` : null,
			m.vision ? "vision" : null,
			m.tool_calling ? "tools" : null,
			alreadyAdded ? "already added" : null,
		].filter(Boolean).join(" · ");

		return `<label class="fetch-item${alreadyAdded ? " already-added" : ""}">
			<input type="checkbox" data-idx="${i}" ${checked ? "checked" : ""} ${alreadyAdded ? "disabled" : ""} />
			<div class="fetch-item-info">
				<div class="fetch-item-id">${escHtml(m.id)}${m.displayName ? `<span class="fetch-item-tag">${escHtml(m.displayName)}</span>` : ""}</div>
				${meta ? `<div class="fetch-item-meta">${escHtml(meta)}</div>` : ""}
				<div class="fetch-item-keytest" data-model="${escHtml(m.id)}"></div>
			</div>
			<button type="button" class="secondary small key-test-btn" data-model="${escHtml(m.id)}" title="Send a hello-world request with every API key">Test keys</button>
		</label>`;
	}).join("");

	el.fetchResults.querySelectorAll("input[type='checkbox']").forEach((cb) => {
		cb.addEventListener("change", updateImportCount);
	});
	el.fetchResults.querySelectorAll(".key-test-btn").forEach((btn) => {
		btn.addEventListener("click", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			testModelKeys(btn.dataset.model);
		});
	});
	updateImportCount();
}

// Render the per-key auth result line shown after fetching models.
function renderKeyTestStatus(keyResults) {
	if (!el.keyTestStatus) return;
	if (!Array.isArray(keyResults) || keyResults.length <= 1) {
		el.keyTestStatus.style.display = "none";
		el.keyTestStatus.innerHTML = "";
		return;
	}
	const okCount = keyResults.filter((r) => r && r.ok).length;
	const marks = keyResults.map((r, i) => {
		const ok = r && r.ok;
		const title = ok ? `Key #${i + 1}: OK` : `Key #${i + 1}: ${escHtml((r && r.error) || "failed")}`;
		return `<span class="key-mark ${ok ? "ok" : "fail"}" title="${title}">${ok ? "✓" : "✗"}</span>`;
	}).join("");
	el.keyTestStatus.style.display = "";
	el.keyTestStatus.innerHTML = `<span class="key-test-label">Keys ${okCount}/${keyResults.length} OK:</span> ${marks}`;
}

// Send a hello-world test for one model against every configured API key.
function testModelKeys(modelId) {
	if (!state.selectedProvider || !modelId) return;
	const info = getProviderInfo(state.selectedProvider);
	const target = el.fetchResults.querySelector(`.fetch-item-keytest[data-model="${cssEsc(modelId)}"]`);
	if (target) {
		target.textContent = "Testing keys…";
		target.className = "fetch-item-keytest testing";
	}
	vscode.postMessage({
		type:      "testModelKeys",
		baseUrl:   info.baseUrl,
		apiKey:    info.apiKey,
		apiMode:   info.apiMode,
		modelId:   modelId,
		proxyUrl:  info.proxyUrl  || undefined,
		userAgent: info.userAgent || undefined,
		headers:   info.headers,
	});
}

// Render per-key checkmarks for a completed model key test.
function renderModelKeyTestResults(modelId, results) {
	const target = el.fetchResults
		? el.fetchResults.querySelector(`.fetch-item-keytest[data-model="${cssEsc(modelId)}"]`)
		: null;
	if (!target) return;
	if (!results.length) {
		target.textContent = "No API keys configured.";
		target.className = "fetch-item-keytest";
		return;
	}
	const okCount = results.filter((r) => r && r.ok).length;
	const marks = results.map((r, i) => {
		const ok = r && r.ok;
		const title = ok ? `Key #${i + 1}: OK` : `Key #${i + 1}: ${escHtml((r && r.error) || "failed")}`;
		return `<span class="key-mark ${ok ? "ok" : "fail"}" title="${title}">${ok ? "✓" : "✗"}</span>`;
	}).join("");
	target.className = "fetch-item-keytest done";
	target.innerHTML = `<span class="key-test-label">${okCount}/${results.length} OK:</span> ${marks}`;
}

// Escape a string for safe use inside a CSS attribute selector.
function cssEsc(value) {
	if (window.CSS && typeof window.CSS.escape === "function") {
		return window.CSS.escape(value);
	}
	return String(value).replace(/["\\\]]/g, "\\$&");
}

// ── Add Model button ───────────────────────────────────────────────────────────

el.addModelBtn.addEventListener("click", () => {
	showModelForm("Add New Model");
	resetModelForm();
	// Pre-fetch models for the dropdown
	if (state.selectedProvider) {
		const info = getProviderInfo(state.selectedProvider);
		state.isFetchingForPanel = false;
		vscode.postMessage({
			type:      "fetchModels",
			baseUrl:   info.baseUrl,
			apiKey:    info.apiKey,
			apiMode:   info.apiMode,
			proxyUrl:  info.proxyUrl  || undefined,
			userAgent: info.userAgent || undefined,
			headers:   info.headers,
		});
	}
});

// ── Advanced toggle ────────────────────────────────────────────────────────────

el.toggleAdvanced.addEventListener("click", () => {
	const open = el.advancedContent.style.display !== "none";
	el.advancedContent.style.display = open ? "none" : "block";
	el.toggleAdvancedLabel.textContent = open ? "▶ Advanced" : "▼ Advanced";
});

// ── Model form save/cancel ─────────────────────────────────────────────────────

$("saveModel").addEventListener("click", () => {
	const data = collectModelFormData();
	if (!validateModelData(data)) {
		return;
	}

	if (el.modelIdInput.hasAttribute("data-editing")) {
		vscode.postMessage({
			type:             "updateModel",
			model:            data,
			originalModelId:  el.modelIdInput.getAttribute("data-original-id"),
			originalConfigId: el.modelIdInput.getAttribute("data-original-configId"),
		});
	} else {
		vscode.postMessage({ type: "addModel", model: data });
	}
	hideModelForm();
	resetModelForm();
});

$("cancelModel").addEventListener("click", () => {
	hideModelForm();
	resetModelForm();
});

// ── Model form helpers ─────────────────────────────────────────────────────────

function showModelForm(title) {
	el.modelFormTitle.textContent = title;
	el.modelFormSection.style.display = "block";
	el.modelFormSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideModelForm() {
	el.modelFormSection.style.display = "none";
}

function resetModelForm() {
	showModelError("");
	[
		"modelIdInput", "modelDisplayName", "modelConfigId", "modelContextLength",
		"modelMaxTokens", "modelMaxCompletionTokens", "modelDelay", "modelTemperature",
		"modelTopP", "modelFamily", "modelTopK", "modelMinP", "modelFrequencyPenalty",
		"modelPresencePenalty", "modelRepetitionPenalty", "modelThinkingBudget",
		"modelReasoningMaxTokens", "modelHeaders", "modelExtra",
	].forEach((f) => { if (el[f]) el[f].value = ""; });

	[
		"modelVision", "modelTools", "modelReasoningEffort", "modelEnableThinking", "modelThinkingType",
		"modelIncludeReasoning", "modelReasoningEnabled", "modelReasoningExclude", "modelReasoningEffortOR",
	].forEach((f) => { if (el[f] && el[f].tagName === "SELECT") el[f].selectedIndex = 0; });

	el.advancedContent.style.display = "none";
	el.toggleAdvancedLabel.textContent = "▶ Advanced";
	el.modelIdInput.removeAttribute("data-editing");
	el.modelIdInput.removeAttribute("data-original-id");
	el.modelIdInput.removeAttribute("data-original-configId");
	dropdownContent.innerHTML = "";
	dropdownHeader.textContent = "— select or type —";
	hideDropdown();
}

function populateModelForm(model) {
	showModelError("");
	el.modelIdInput.setAttribute("data-editing", "true");
	el.modelIdInput.setAttribute("data-original-id",       model.id       || "");
	el.modelIdInput.setAttribute("data-original-configId", model.configId || "");

	el.modelIdInput.value            = model.id             || "";
	el.modelDisplayName.value        = model.displayName    || "";
	el.modelConfigId.value           = model.configId       || "";
	el.modelContextLength.value      = model.context_length != null ? model.context_length : "";
	el.modelMaxTokens.value          = model.max_tokens     != null ? model.max_tokens     : "";
	el.modelMaxCompletionTokens.value = model.max_completion_tokens != null ? model.max_completion_tokens : "";
	el.modelVision.value             = model.vision         != null ? String(model.vision) : "";
	el.modelTools.value              = model.tool_calling   != null ? String(model.tool_calling) : "";
	el.modelDelay.value              = model.delay          != null ? model.delay          : "";
	el.modelTemperature.value        = model.temperature    != null ? model.temperature    : "";
	el.modelTopP.value               = model.top_p          != null ? model.top_p          : "";
	el.modelFamily.value             = model.family         || "";
	el.modelTopK.value               = model.top_k          != null ? model.top_k          : "";
	el.modelMinP.value               = model.min_p          != null ? model.min_p          : "";
	el.modelFrequencyPenalty.value   = model.frequency_penalty   != null ? model.frequency_penalty   : "";
	el.modelPresencePenalty.value    = model.presence_penalty    != null ? model.presence_penalty    : "";
	el.modelRepetitionPenalty.value  = model.repetition_penalty  != null ? model.repetition_penalty  : "";
	el.modelReasoningEffort.value    = model.reasoning_effort    || "";
	el.modelEnableThinking.value     = model.enable_thinking     != null ? String(model.enable_thinking) : "";
	el.modelThinkingBudget.value     = model.thinking_budget     != null ? model.thinking_budget         : "";
	el.modelIncludeReasoning.value   = model.include_reasoning_in_request != null
		? String(model.include_reasoning_in_request) : "";
	el.modelThinkingType.value       = model.thinking?.type || "";
	el.modelReasoningEnabled.value   = model.reasoning?.enabled  != null ? String(model.reasoning.enabled)  : "";
	el.modelReasoningEffortOR.value  = model.reasoning?.effort   || "";
	el.modelReasoningExclude.value   = model.reasoning?.exclude  != null ? String(model.reasoning.exclude)  : "";
	el.modelReasoningMaxTokens.value = model.reasoning?.max_tokens != null ? model.reasoning.max_tokens      : "";
	el.modelHeaders.value            = model.headers ? JSON.stringify(model.headers, null, 2) : "";
	el.modelExtra.value              = model.extra   ? JSON.stringify(model.extra,   null, 2) : "";
}

function collectModelFormData() {
	return {
		id:           el.modelIdInput.value.trim(),
		owned_by:     state.selectedProvider || "",
		displayName:  el.modelDisplayName.value.trim()  || undefined,
		configId:     el.modelConfigId.value.trim()     || undefined,
		context_length:            numOrUndef(el.modelContextLength.value),
		max_tokens:                numOrUndef(el.modelMaxTokens.value),
		max_completion_tokens:     numOrUndef(el.modelMaxCompletionTokens.value),
		vision:                    boolOrUndef(el.modelVision.value),
		tool_calling:              boolOrUndef(el.modelTools.value),
		delay:                     numOrUndef(el.modelDelay.value),
		temperature:               floatOrUndef(el.modelTemperature.value),
		top_p:                     floatOrUndef(el.modelTopP.value),
		family:                    el.modelFamily.value.trim() || undefined,
		top_k:                     numOrUndef(el.modelTopK.value),
		min_p:                     floatOrUndef(el.modelMinP.value),
		frequency_penalty:         floatOrUndef(el.modelFrequencyPenalty.value),
		presence_penalty:          floatOrUndef(el.modelPresencePenalty.value),
		repetition_penalty:        floatOrUndef(el.modelRepetitionPenalty.value),
		reasoning_effort:          el.modelReasoningEffort.value || undefined,
		enable_thinking:           boolOrUndef(el.modelEnableThinking.value),
		thinking_budget:           numOrUndef(el.modelThinkingBudget.value),
		include_reasoning_in_request: boolOrUndef(el.modelIncludeReasoning.value),
		thinking:  el.modelThinkingType.value ? { type: el.modelThinkingType.value } : undefined,
		reasoning: buildReasoningObj(),
		headers:   parseJson(el.modelHeaders.value),
		extra:     parseJson(el.modelExtra.value),
	};
}

function buildReasoningObj() {
	const enabled   = boolOrUndef(el.modelReasoningEnabled.value);
	const effort    = el.modelReasoningEffortOR.value || undefined;
	const exclude   = boolOrUndef(el.modelReasoningExclude.value);
	const maxTokens = numOrUndef(el.modelReasoningMaxTokens.value);
	if (enabled === undefined && effort === undefined && exclude === undefined && maxTokens === undefined) return undefined;
	return { enabled, effort, exclude, max_tokens: maxTokens };
}

function validateModelData(d) {
	showModelError("");
	if (!d.id)       { showModelError("Model ID is required.");  return false; }
	if (!d.owned_by) { showModelError("No provider selected."); return false; }

	const editing      = el.modelIdInput.hasAttribute("data-editing");
	const origId       = el.modelIdInput.getAttribute("data-original-id");
	const origConfigId = el.modelIdInput.getAttribute("data-original-configId");

	const dup = state.models
		.filter((m) => {
			if (editing) {
				const isSelf = m.id === origId && (origConfigId ? m.configId === origConfigId : !m.configId);
				return !isSelf;
			}
			return true;
		})
		.some((m) => m.id === d.id && (d.configId ? m.configId === d.configId : !m.configId));

	if (dup) { showModelError(`"${d.id}${d.configId ? "::" + d.configId : ""}" already exists.`); return false; }

	if (d.max_tokens != null && d.max_completion_tokens != null)
		{ showModelError("Cannot set both max_tokens and max_completion_tokens."); return false; }
	if (d.temperature != null && (d.temperature < 0 || d.temperature > 2))
		{ showModelError("Temperature must be 0–2."); return false; }
	if (d.top_p != null && (d.top_p < 0 || d.top_p > 1))
		{ showModelError("Top P must be 0–1."); return false; }
	return true;
}

function showModelError(msg) {
	el.modelError.textContent = msg;
	el.modelError.style.display = msg ? "block" : "none";
	if (msg) el.modelError.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Model ID dropdown ──────────────────────────────────────────────────────────

function populateModelDropdown(models) {
	const arr = Array.isArray(models) ? models : [];
	dropdownContent.innerHTML = "";
	if (!arr.length) {
		dropdownHeader.textContent = "No models returned";
		return;
	}
	dropdownHeader.textContent = `${arr.length} model(s) — click to select`;
	arr.forEach((m) => {
		const div = document.createElement("div");
		div.className = "dropdown-option";
		div.textContent = m.id;
		div.dataset.modelId = m.id;
		div.addEventListener("click", () => {
			el.modelIdInput.value = m.id;
			if (m.tool_calling != null) {
				el.modelTools.value = String(m.tool_calling);
			}
			if (m.vision != null) {
				el.modelVision.value = String(m.vision);
			}
			if (m.reasoning_effort) {
				el.modelReasoningEffort.value = String(m.reasoning_effort);
			} else if (m.enable_thinking === true || m.reasoning?.enabled === true) {
				el.modelReasoningEffort.value = "medium";
			}
			hideDropdown();
		});
		dropdownContent.appendChild(div);
	});
}

function showDropdown() {
	if (dropdownContent.children.length > 0) el.modelIdDropdown.classList.add("show");
}
function hideDropdown() { el.modelIdDropdown.classList.remove("show"); }

el.modelIdInput.addEventListener("focus", () => showDropdown());
el.modelIdInput.addEventListener("input", () => {
	const term = el.modelIdInput.value.toLowerCase();
	let visible = 0;
	dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
		const match = opt.dataset.modelId.toLowerCase().includes(term);
		opt.style.display = match ? "" : "none";
		if (match) visible++;
	});
	dropdownHeader.textContent = term ? `${visible} matching` : `${dropdownContent.children.length} model(s)`;
	showDropdown();
});
el.modelIdInput.addEventListener("keydown", (e) => {
	if (e.key === "Escape") hideDropdown();
	if (e.key === "ArrowDown") {
		e.preventDefault();
		const first = dropdownContent.querySelector(".dropdown-option");
		if (first) first.focus();
	}
});
document.addEventListener("click", (e) => {
	if (!el.modelIdDropdown.contains(e.target) && e.target !== el.modelIdInput) hideDropdown();
});

// ── Message receiver ───────────────────────────────────────────────────────────

window.addEventListener("message", ({ data: msg }) => {
	switch (msg.type) {
		case "init": {
			const p = msg.payload;
			state.models         = p.models         || [];
			state.providerKeys   = p.providerKeys   || {};
			state.commitModel    = p.commitModel    || "";
			state.commitLanguage = p.commitLanguage || "English";

			populateCommitModelDropdown();
			el.commitModel.value    = state.commitModel;
			el.commitLanguage.value = state.commitLanguage;
			populateChatGenModelDropdown();

			if (el.allowAnonymousAccess) {
				el.allowAnonymousAccess.checked = p.allowAnonymousAccess === true;
			}
			if (el.restoreChatSessions) {
				el.restoreChatSessions.checked = p.restoreChatSessions === true;
			}
			if (el.telemetryDisabled) {
				el.telemetryDisabled.checked = p.telemetryDisabled === true;
			}
			if (el.chatRetries) {
				el.chatRetries.value = String(p.chatRetries != null ? p.chatRetries : 0);
			}
			if (el.chatRetryInterval) {
				el.chatRetryInterval.value = String(p.chatRetryInterval != null ? p.chatRetryInterval : 1000);
			}
			if (el.chatRetryJitter) {
				el.chatRetryJitter.value = String(p.chatRetryJitter != null ? p.chatRetryJitter : 0);
			}

			// Refresh sidebar
			renderSidebar();

			// Refresh current view
			if (state.isNewProvider) {
				// If the new provider was just saved and now exists, select it so
				// the models section (and Fetch from API button) becomes available.
				if (state.pendingNewProvider && getProviders().includes(state.pendingNewProvider)) {
					const newName = state.pendingNewProvider;
					state.pendingNewProvider = null;
					state.isNewProvider = false;
					selectProvider(newName);
				}
				// else keep form open (just updated sidebar)
			} else if (state.selectedProvider === "git-commit") {
				selectGitCommitSettings();
			} else if (state.selectedProvider === "integration") {
				selectIntegrationSettings();
			} else if (state.selectedProvider === "chatgen") {
				selectChatGenSettings();
			} else if (state.selectedProvider) {
				const stillExists = getProviders().includes(state.selectedProvider);
				if (stillExists) {
					selectProvider(state.selectedProvider);
				} else {
					showEmptyState();
				}
			} else {
				showEmptyState();
			}
			break;
		}
		case "modelsFetched": {
			const models = msg.models || [];
			if (state.isFetchingForPanel) {
				showFetchResults(models, msg.keyResults);
			} else {
				populateModelDropdown(models);
			}
			break;
		}
		case "keyStats": {
			renderKeyStats(msg.provider, msg.stats || []);
			break;
		}
		case "modelKeysTested": {
			renderModelKeyTestResults(msg.modelId, msg.results || []);
			break;
		}
		case "modelsFetchError": {
			if (state.isFetchingForPanel) {
				el.fetchStatus.textContent = `Error: ${msg.error || "Failed to fetch models"}`;
				el.fetchResults.innerHTML = "";
				state.isFetchingForPanel = false;
			} else {
				dropdownHeader.textContent = "Error fetching models";
				dropdownContent.innerHTML = `<div class="dropdown-option" style="color:var(--vscode-errorForeground)">${escHtml(msg.error || "Failed")}</div>`;
			}
			break;
		}
		case "confirmResponse": {
			const pending = pendingConfirmations.get(msg.id);
			if (pending) {
				if (msg.confirmed && pending.action) pending.action();
				pendingConfirmations.delete(msg.id);
			}
			break;
		}
	}
});

// ── Utility ────────────────────────────────────────────────────────────────────

function parseFullModelId(mid) {
	const sep = mid.indexOf("::");
	return sep !== -1
		? { baseId: mid.slice(0, sep), configId: mid.slice(sep + 2) }
		: { baseId: mid, configId: null };
}

function fmtNum(n) {
	if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
	if (n >= 1000)    return (n / 1000).toFixed(0) + "k";
	return String(n);
}

function parseJson(str) {
	if (!str || !str.trim()) return undefined;
	try { return JSON.parse(str.trim()); } catch { return undefined; }
}

function numOrUndef(val) {
	if (val === "" || val == null) return undefined;
	const n = parseInt(String(val), 10);
	return isNaN(n) ? undefined : n;
}

function floatOrUndef(val) {
	if (val === "" || val == null) return undefined;
	const n = parseFloat(String(val));
	return isNaN(n) ? undefined : n;
}

function boolOrUndef(val) {
	if (val === "true")  return true;
	if (val === "false") return false;
	return undefined;
}

function escHtml(str) {
	return String(str ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
const escAttr = escHtml;

// ── Bootstrap ──────────────────────────────────────────────────────────────────

vscode.postMessage({ type: "requestInit" });
