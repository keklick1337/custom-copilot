# AGENTS.md

Guidance for automated agents (and humans) contributing to **Copilot Custom Models Endpoint**
(`keklick1337/custom-copilot`) — a VS Code extension that exposes any OpenAI-compatible /
Ollama / Anthropic / Gemini endpoint to GitHub Copilot Chat via the Language Model Chat
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
- `tsconfig.json` **excludes** `node_modules`, `out`, `vscode`, `tmp`, `oai-compatible-copilot`.
  `tmp/` may contain a full `vscode` clone for reference — never import from it, and it is
  excluded from `tsc`, `eslint` (`eslint.config.mjs` ignores), and `prettier`
  (`.prettierignore`) so it does not eat build/lint time.

## Architecture

The extension registers one `LanguageModelChatProvider` **per `apiMode`** (vendor ids
`copilotcustommodelsendpoint`, `…-responses`, `…-anthropic`, `…-gemini`, `…-ollama`; see
`package.json` → `contributes.languageModelChatProviders`). Each vendor lists only the models
whose `apiMode` matches, so every protocol shows up as a separate group in the model picker.
Each request is dispatched to the adapter matching the model's `apiMode`.

| Layer | Files |
|---|---|
| Extension entry | `src/extension.ts` — registers one provider per vendor/`apiMode`, status bar, commit commands, the webview configuration view, and the one-time telemetry-privacy default. |
| Chat provider | `src/provider.ts` — `HuggingFaceChatModelProvider` implements `vscode.LanguageModelChatProvider`; an optional `vendorApiMode` filters the listed models, and requests route per `apiMode`. |
| Shared adapter base | `src/commonApi.ts` — `CommonApi` base class: streamed tool-call assembly, thinking parts, JSON helpers. |
| API adapters | `src/openai/openaiApi.ts`, `src/openai/openaiResponsesApi.ts`, `src/ollama/ollamaApi.ts`, `src/anthropic/anthropicApi.ts`, `src/gemini/geminiApi.ts` (+ matching `*Types.ts`). |
| Model discovery | `src/provideModel.ts` — `prepareLanguageModelChatInformation` + `fetchModels` (`/v1/models` and per-protocol fetchers). |
| Capability inference | `src/modelCapabilities.ts` — infers vision / tool-calling / context / reasoning from `/v1/models` fields, falling back to model-id heuristics and safe defaults (mirrors VS Code BYOK). |
| Token counting | `src/provideToken.ts` + `src/tokenizer/` — local `o200k_base` tokenizer (`assets/model/o200k_base.tiktoken`) and image-token estimation. |
| Networking | `src/network.ts` — `undici`-based fetch init with proxy support; `src/versionManager.ts` — default User-Agent / version. |
| Configuration UI | `src/views/configView.ts` (webview host `SettingsViewProvider` / `ConfigViewController`) + `assets/configure/{configure.html,configure.css,configure.js}` (webview front-end). |
| Git commits | `src/gitCommit/` — `commitMessageGenerator.ts`, `gitUtils.ts` (SCM commit-message generation). |
| Status bar | `src/statusBar.ts` — provider / token usage / quick access. |
| Logging | `src/logger.ts` — JSON-lines file logger. |
| Types & utils | `src/types.ts` (`HFModelItem`, configs), `src/utils.ts` (`normalizeUserModels`, proxy helpers). |

## Conventions

- **Proposed APIs**: `chatProvider`, `languageModelDataPart`, `languageModelThinkingPart`.
  Their `.d.ts` files live at `src/vscode.proposed.*.d.ts` and are refreshed via
  `npm run download-api`. `package.json` → `enabledApiProposals` must list each one used.
- **Secrets** (`vscode.SecretStorage`):
  - Per-provider key only: `customcopilot.apiKey.<providerLowercase>` (legacy mixed-case keys
    are migrated on read). There is **no** global/default API key. Do not change this scheme
    without a migration path.
- **Config namespace**: `customcopilot.*` — declared in `package.json`
  → `contributes.configuration`. Models live in `customcopilot.models`.
- **Model normalisation**: always read models through `normalizeUserModels` (`src/utils.ts`);
  `owned_by` is canonicalised from the aliases `provider` / `provide`.
- **Multi-config models** are addressed as `<id>::<configId>` everywhere user-facing
  (model picker, logs, UI).
- **`apiMode`** is the single switch selecting the adapter:
  `openai` (default) · `openai-responses` · `ollama` · `anthropic` · `gemini`.

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

## Debugging

- `F5` launches the Extension Development Host (`.vscode/launch.json` passes
  `--enable-proposed-api=keklick1337.keklick-copilot`).
- Webview dev tools: command palette → *Developer: Open Webview Developer Tools*.
- File logging level: `customcopilot.logLevel` (`off` | `debug` | `info` | `warn` | `error`).
  Logs land under `~/.copilot/customcopilot/logs/` (see `src/logger.ts`).

## Code Style (`eslint.config.mjs`)

- Tabs for indentation (`@stylistic/indent`).
- Double quotes (`@stylistic/quotes`).
- Required semicolons (`@stylistic/semi`).
- Required braces (`curly`).
- Unused identifiers must start with `_` (`@typescript-eslint/no-unused-vars`).

## What Not To Do

- Do not import from `tmp/` or `oai-compatible-copilot/` (reference clones, excluded from the build).
- Do not commit transient debug `console.log` in production paths. Errors may use
  `console.error` with the `[customcopilot]` tag; non-error diagnostics belong in `logger`.
- Do not bypass `normalizeUserModels` when reading `customcopilot.models`.
- Do not duplicate the configuration webview host (`src/views/configView.ts`).
- Do not change the secret-key naming scheme without migrating existing keys.

