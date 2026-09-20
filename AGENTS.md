# AGENTS.md

Guidance for automated agents (and humans) contributing to **Copilot Custom Models Endpoint**
(`keklick1337/custom-copilot`) — a VS Code extension that exposes any OpenAI-compatible /
Ollama / Anthropic / Gemini / Z.AI endpoint to GitHub Copilot Chat via the Language Model Chat
Provider API.

## Build / Test / Lint

```bash
npm install            # install dependencies
npm run compile        # tsc -p ./  → out/
npm run watch          # tsc --watch (used by the F5 dev host)
npm run lint           # eslint src
npm run format         # prettier --write . (respects .prettierignore)
npm run test           # compile + @vscode/test-electron
npm run build          # vsce package → extension.vsix
npm run download-api   # refresh the proposed-API .d.ts files
```

- Output goes to `out/`. The packaged artifact is `extension.vsix`.
- Minimum supported VS Code version is declared in `package.json` → `engines.vscode`
  (currently `^1.134.0`); keep `package-lock.json` in sync when it changes.
- There is no unit-test suite yet (`npm run test` runs the extension host harness with 0
  tests as a smoke check). Verify changes with `npm run compile && npm run lint && npm run build`.

## Architecture

The extension registers one `LanguageModelChatProvider` **per `apiMode`** (vendor ids
`copilotcustommodelsendpoint`, `…-responses`, `…-anthropic`, `…-gemini`, `…-ollama`, `…-zai`;
see `package.json` → `contributes.languageModelChatProviders` and the single `VENDOR_MODES`
constant in `src/extension.ts`). Each vendor lists only the models whose `apiMode` matches,
so every protocol shows up as a separate group in the model picker. Each request is dispatched
to the adapter matching the model's `apiMode`.

| Layer | Files |
|---|---|
| Extension entry | `src/extension.ts` — registers one provider per vendor/`apiMode` (`VENDOR_MODES`), status bar, commit commands, the webview configuration view, and the one-time telemetry-privacy default. |
| Chat provider | `src/provider.ts` — `CustomEndpointChatProvider` implements `vscode.LanguageModelChatProvider`; an optional `vendorApiMode` filters the listed models, and requests route per `apiMode` through ONE shared `sendWithRetry` dispatcher (fetch + retry + key rotation + error formatting exist once; each apiMode branch only builds URL/body/stream-processor). After streaming it reports token usage as a `LanguageModelDataPart` with mimeType `"usage"` — the internal contract Copilot Chat's context-usage circle reads (same as Copilot's own BYOK providers). |
| Shared adapter base | `src/commonApi.ts` — `CommonApi` base class: streamed tool-call assembly (per-index flush), thinking parts, XML `<think>` streaming state machine, `ApiUsage` accumulation, `resetRequestState()` (adapters are REUSED across turns — every `convertMessages`/`processStreamingResponse` MUST start with it), JSON helpers, header preparation. |
| API adapters | `src/openai/openaiApi.ts`, `src/openai/openaiResponsesApi.ts`, `src/ollama/ollamaApi.ts`, `src/anthropic/anthropicApi.ts`, `src/gemini/geminiApi.ts` (+ matching `*Types.ts`). |
| Gemini split | `src/gemini/geminiUrls.ts` (URL building / id normalization), `src/gemini/geminiTools.ts` (OpenAI tool-schema → Gemini function declarations + JSON-Schema sanitization), `src/gemini/geminiModels.ts` (model listing). |
| Reasoning efforts | `src/reasoningEffort.ts` — effort ladder + `clampEffort` (ported from hermes-agent's reasoning-effort module): clamps to the nearest WEAKER supported level, never escalates cost, never clamps to `none`. GLM-5.2/5.3 vocabularies. |
| Model discovery | `src/provideModel.ts` — `prepareLanguageModelChatInformation` + `fetchModels` (`/v1/models` and per-protocol fetchers). |
| Capability inference | `src/modelCapabilities.ts` — infers vision / tool-calling / context / reasoning from `/v1/models` fields, falling back to model-id heuristics and safe defaults (mirrors VS Code BYOK). |
| Token counting | `src/provideToken.ts` + `src/tokenizer/` — local `o200k_base` tokenizer (`assets/model/o200k_base.tiktoken`) and image-token estimation. |
| Networking | `src/network.ts` — undici-based `proxyFetch` with per-request ProxyAgent dispatcher (bypasses VS Code's patched global fetch which drops the dispatcher — REQUIRED for proxy support), proxy URL normalization (`socks5h`→`socks5`, `direct`/`none` tokens), masked curl-reproduction debug logging (denylist-by-default header masking); `src/versionManager.ts` — default User-Agent / version. |
| Configuration UI | `src/views/configView.ts` (webview host `SettingsViewProvider` / `ConfigViewController`), `src/views/modelKeys.ts` (webview model-key parsing), `src/views/configTransfer.ts` (export/import), + `assets/configure/{configure.html,configure.css,configure.js}` (webview front-end; `PROVIDER_PRESETS` catalog of 40+ provider presets with optgroup categories). |
| Git commits | `src/gitCommit/` — `commitMessageGenerator.ts`, `gitUtils.ts` (all git calls via `execFile` argument arrays — NEVER shell-string interpolation). |
| Status bar | `src/statusBar.ts` — provider / token usage / quick access; resolves the model config through the shared `resolveUserModelById`. |
| Logging | `src/logger.ts` — JSON-lines file logger. |
| Types & utils | `src/types.ts` (`CustomModelItem`, configs), `src/utils.ts` (`normalizeUserModels`, `resolveUserModelById`, proxy helpers, `safeUrlHost`). |

## Conventions

- **Proposed APIs**: `chatProvider`. The `.d.ts` lives at `src/vscode.proposed.chatProvider.d.ts`
  and is refreshed via `npm run download-api`. `package.json` → `enabledApiProposals` must list
  each one used.
- **Secrets** (`vscode.SecretStorage`):
  - Per-provider key only: `customcopilot.apiKey.<providerLowercase>` (legacy mixed-case keys
    are migrated on read; multiple keys are stored newline-separated under the same secret).
  - Optional per-provider remote key source: `customcopilot.apiKeySource.<providerLowercase>`
    (a file path or URL returning a key list, fetched fresh per request).
  - There is **no** global/default API key. Do not change this scheme without a migration path.
- **Config namespace**: `customcopilot.*` — declared in `package.json`
  → `contributes.configuration`. Models live in `customcopilot.models`.
- **Model normalisation**: always read models through `normalizeUserModels` (`src/utils.ts`);
  `owned_by` is canonicalised from the aliases `provider` / `provide`.
- **Model resolution**: map a (possibly `provider:idx:`-prefixed) model id back to its config
  entry ONLY via `resolveUserModelById` (`src/utils.ts`) — it is the single source of truth
  shared by provider.ts and statusBar.ts. Never re-implement the idx matching by hand.
- **Multi-config models** are addressed as `<id>::<configId>` everywhere user-facing
  (model picker, logs, UI); webview keys may add `#index` (see `src/views/modelKeys.ts`).
- **`apiMode`** is the single switch selecting the adapter:
  `openai` (default) · `openai-responses` · `ollama` · `anthropic` · `gemini` · `zai`.
- **Adapter state**: adapters are instantiated per request in provider.ts, but EVERY
  `convertMessages`/`processStreamingResponse` implementation must still call
  `this.resetRequestState()` first — the base class documents why.
- **Reasoning efforts**: never forward a user effort verbatim; clamp through
  `clampEffort`/`glmReasoningEffort` (`src/reasoningEffort.ts`).
- **Thinking budgets**: output ceilings must exceed the thinking budget (Anthropic:
  `max_tokens ≥ budget + 4096`; Gemini: raise `maxOutputTokens` to 65535 when thinking is on,
  gemini-family models only — Gemma rejects `thinkingConfig`).
- **Usage reporting**: adapters accumulate `_lastUsage` via `accumulateUsage` (merged across
  partial stream events); provider.ts emits it once, after the stream completes, as a
  `LanguageModelDataPart(_, "usage")`.
- **Proxies**: all outbound provider traffic goes through `proxyFetch` from `src/network.ts` —
  never the global `fetch` (VS Code patches it and silently drops the undici dispatcher,
  breaking proxies). Per-model `proxyUrl` overrides the global `customcopilot.proxyUrl`;
  `direct`/`none` forces a direct connection.
- **Vendor list**: the vendor id ↔ apiMode ↔ display name ↔ default base URL table lives
  ONLY in `VENDOR_MODES` (`src/extension.ts`) and must mirror
  `package.json` → `contributes.languageModelChatProviders`.

## Configuration UI (webview)

- It is a **webview view** (`viewType` `customcopilot.settingsView`) hosted in the
  `customcopilot-sidebar` activity-bar container — not an editor tab. Because the panel is
  narrow, the layout is responsive: in the "home" (`screen-list`) state the main panel is
  hidden, so any settings that must be reachable need their **own sidebar entry / screen**
  (the working pattern is the `Git Commit Settings` and `Global Settings` special items).
- The single source of truth is `src/views/configView.ts`. Do not introduce a second
  `SettingsPanel` / `ConfigViewController`.
- Assets in `assets/configure/` are plain HTML/CSS/JS (not compiled by `tsc`); they are
  loaded with CSP placeholders (`%CSP_SOURCE%`, `%CSS_URI%`, `%SCRIPT_URI%`, `%NONCE%`).
  The nonce is generated with `crypto.randomBytes` (never `Math.random`).
- The provider preset catalog (`PROVIDER_PRESETS` in `configure.js`) mirrors the provider
  registry of hermes-agent; OAuth-only providers are intentionally excluded (the extension
  has no credential flows) — their endpoints can be entered manually.

## Debugging

- `F5` launches the Extension Development Host (`.vscode/launch.json` passes
  `--enable-proposed-api=keklick1337.keklick-copilot`).
- Webview dev tools: command palette → *Developer: Open Webview Developer Tools*.
- File logging level: `customcopilot.logLevel` (`off` | `debug` | `info` | `warn` | `error`).
  Logs land under `~/.copilot/customcopilot/logs/` (see `src/logger.ts`). Full message
  content is only logged when `customcopilot.logMessageContent` is explicitly enabled.
- Failed-request curl reproductions: `customcopilot.debugRequestLogging` (header values are
  masked unless known-safe).

## Code Style (`eslint.config.mjs`)

- Tabs for indentation (`@stylistic/indent`).
- Double quotes (`@stylistic/quotes`).
- Required semicolons (`@stylistic/semi`).
- Required braces (`curly`).
- Unused identifiers must start with `_` (`@typescript-eslint/no-unused-vars`).

## What Not To Do

- Do not commit transient debug `console.log` in production paths. Errors may use
  `console.error` with the `[customcopilot]` tag; non-error diagnostics belong in `logger`.
- Do not bypass `normalizeUserModels` when reading `customcopilot.models`.
- Do not duplicate the configuration webview host (`src/views/configView.ts`).
- Do not change the secret-key naming scheme without migrating existing keys.
- Do not call the global `fetch` for provider traffic — use `proxyFetch` (proxies break otherwise).
- Do not re-implement model-id → config resolution; use `resolveUserModelById`.
- Do not forward reasoning efforts verbatim; always clamp (`src/reasoningEffort.ts`).
- Do not interpolate user input into shell strings in `gitUtils.ts` — `execFile` with
  argument arrays only.
- Do not log full conversations or unmasked custom headers; both are gated/masked by design.
