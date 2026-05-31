<div align="center">

<img src="https://raw.githubusercontent.com/keklick1337/custom-copilot/master/assets/logo.png" alt="Copilot Custom Models Endpoint" width="120" />

# Copilot Custom Models Endpoint

**Bring any OpenAI‑compatible, Ollama, Anthropic, or Gemini endpoint to GitHub Copilot Chat.**

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=keklick1337.keklick-copilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

This extension registers a **Language Model Chat Provider** for GitHub Copilot Chat. It lets
you add your own models — from a self‑hosted server, a cloud OpenAI‑compatible router, a local
Ollama install, or the native Anthropic / Gemini APIs — and use them directly inside the
Copilot Chat model picker, with full support for tools, vision, and reasoning/thinking output.

> **Bring Your Own Key (BYOK).** You supply the endpoint and API key; nothing is proxied
> through any third party. A built‑in privacy default disables VS Code telemetry on first run
> so the names of the models/providers you use are not reported.

## ✨ Highlights

- **Five API modes** — `openai` (Chat Completions), `openai-responses`, `ollama`,
  `anthropic`, and `gemini`. One `apiMode` switch per model picks the adapter.
- **Visual configuration panel** — a dedicated activity‑bar sidebar to add providers,
  fetch models, and tune parameters without hand‑editing JSON.
- **Automatic capability detection** — when you fetch models from a `/v1/models` endpoint,
  vision, tool‑calling, context length, and reasoning are inferred from the endpoint fields,
  with sensible model‑id heuristics and safe fallbacks.
- **Tools, vision & thinking** — function calling, image input, and reasoning/“thinking”
  blocks are surfaced in Copilot Chat where the model supports them.
- **Multi‑provider & multi‑config** — group models by provider with per‑provider API keys,
  and define the same model id multiple times with different settings via `configId`.
- **Git commit messages** — generate SCM commit messages from your own model.
- **Persistent chat sessions** — keep and restore your chat history across full VS Code
  restarts (`chat.restoreLastPanelSession`), even when using Copilot without a GitHub account.
- **Chat Generator** — turn one prompt template into many Copilot chats at once: substitute a
  per‑line value (`[REPLACE_THAT]`) or JSONL patterns (`[KEY]`), pick the mode and model, and
  launch the sessions sequentially or in parallel.
- **Per‑model control** — base URL, proxy, User‑Agent, headers, extra body params, temperature,
  top‑p/k, penalties, reasoning effort, thinking budget, request delay, and retry.
- **Local token counting** — usage is estimated locally with the bundled `o200k_base` tokenizer.

## 📦 Requirements

- VS Code **1.104.0** or newer.
- GitHub Copilot Chat installed and signed in.
- An endpoint URL and (usually) an API key.

## 🚀 Install & First Run

1. Install **Copilot Custom Models Endpoint** from the Marketplace (or `code --install-extension extension.vsix`).
2. Open the **Custom Copilot** view from the activity bar (the sidebar icon) to open the
   configuration panel.
3. Add a provider: set its **Base URL** and (optionally) fetch the model list, or add models
   manually.
4. Set the provider's API key when prompted, or run **Custom Copilot: Set API Key For Source**
   from the Command Palette.
5. In Copilot Chat, open the model picker → **Manage Models…** → choose **CustomCopilot**, and
   enable the models you want.

## 🛠 Configuration UI

The configuration panel is a webview hosted in its own activity‑bar container. From it you can:

- **Providers** — add/edit providers, set base URL / proxy / User‑Agent, and **Fetch from API**
  to import models (capabilities are auto‑detected).
- **Global Settings** — toggle privacy‑ and persistence‑related options:
  - **Anonymous access** (`chat.allowAnonymousAccess`).
  - **Save & restore chat sessions across restarts** (`chat.restoreLastPanelSession`) — keep
    your last chat after VS Code is fully restarted, even without a GitHub account.
  - **Disable telemetry** (`telemetry.telemetryLevel`), which is also set off on first run.
- **Git Commit Settings** — pick the model and language used for commit‑message generation.
- **Chat Generator** — generate and launch many chats from a single prompt template (see below).
- **User‑Agent presets** — a dropdown of common desktop/mobile User‑Agent strings plus a
  🎲 button to pick one at random; the default is a Mozilla/Chrome string.
- **Import / Export** — move your provider/model configuration in or out as JSON.

You can also edit everything directly through VS Code Settings under the `customcopilot.*`
namespace (see **Settings reference** below).

## 🔀 API Modes

Set `apiMode` per model to select the protocol adapter:

| `apiMode` | Endpoint | Notes |
|---|---|---|
| `openai` *(default)* | `POST {baseUrl}/chat/completions` | Standard OpenAI Chat Completions. |
| `openai-responses` | `POST {baseUrl}/responses` | OpenAI Responses API; supports reasoning summaries. |
| `ollama` | `POST {baseUrl}/api/chat` | Local Ollama; API key optional. |
| `anthropic` | `POST {baseUrl}/v1/messages` | Native Anthropic Messages API. |
| `gemini` | `POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse` | Native Google Gemini API. |

Each mode converts messages, tools, images, and thinking blocks to the provider's native format.

## 👥 Multi‑Provider

`owned_by` (aliases: `provider` / `provide`) groups models by provider. Each provider gets its
own API key stored as the secret `customcopilot.apiKey.<providerLowercase>`. Use
**Custom Copilot: Set API Key For Source** to set them. There is no global/default API key —
every model authenticates with its provider's key.

```jsonc
"customcopilot.baseUrl": "https://api-inference.modelscope.cn/v1",
"customcopilot.models": [
  {
    "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "owned_by": "modelscope",
    "context_length": 256000,
    "max_tokens": 8192
  },
  {
    "id": "qwen3-coder",
    "owned_by": "iflow",
    "baseUrl": "https://apis.iflow.cn/v1",
    "context_length": 256000,
    "max_tokens": 8192
  }
]
```

## 🧩 Multi‑Config (same model, different settings)

Use `configId` to register the same model id with different settings. Each entry appears
separately in the model picker as `<id>::<configId>`.

```jsonc
"customcopilot.models": [
  {
    "id": "glm-4.6",
    "configId": "thinking",
    "owned_by": "zai",
    "temperature": 0.7,
    "thinking": { "type": "enabled" }
  },
  {
    "id": "glm-4.6",
    "configId": "no-thinking",
    "owned_by": "zai",
    "temperature": 0,
    "thinking": { "type": "disabled" }
  }
]
```

→ `glm-4.6::thinking` and `glm-4.6::no-thinking` both appear in Copilot Chat.

## 🧷 Custom Headers

`headers` adds custom HTTP headers to every request for a model. They are merged with the
default headers (`Authorization`, `Content-Type`, `User-Agent`) and take precedence on conflict.

```jsonc
{
  "id": "custom-model",
  "owned_by": "provider",
  "baseUrl": "https://api.example.com/v1",
  "headers": {
    "X-API-Version": "2024-01",
    "X-Request-Source": "vscode-copilot"
  }
}
```

## 🧪 Custom Request Body (`extra`)

`extra` merges arbitrary parameters into the request body — useful for provider‑specific or
experimental features not covered by the dedicated fields. Works in all API modes.

```jsonc
{
  "id": "gpt-4o-mini",
  "owned_by": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiMode": "openai-responses",
  "reasoning_effort": "high",
  "extra": { "reasoning": { "summary": "detailed" } }
}
```

```jsonc
{
  "id": "gemini-3-flash-preview",
  "owned_by": "gemini",
  "baseUrl": "https://generativelanguage.googleapis.com",
  "apiMode": "gemini",
  "extra": { "generationConfig": { "thinkingConfig": { "includeThoughts": true } } }
}
```

`extra` values override standard parameters on conflict, so prefer the dedicated fields where
they exist.

## 🧰 Git Commit Messages

Mark a model with `"useForCommitGeneration": true`, then use the **Generate Commit Message**
button in the Source Control title bar (or the command of the same name). The output language is
controlled by `customcopilot.commitLanguage`, and you can override the prompt with
`customcopilot.commitMessagePrompt`. The `gemini` API mode is not supported for commit generation.

## ⚡ Chat Generator

Open the **Chat Generator** entry in the configuration sidebar to fan a single prompt template
out into many Copilot chats at once — handy for running the same task across many files, items,
or variants.

1. **Prompt template** — write your prompt with a placeholder.
2. **Replacement source** — choose one of two modes:
   - **Simple** — replace a token (default `[REPLACE_THAT]`, configurable) with each non‑empty
     line of the values box. One line → one chat.
   - **Advanced (JSONL)** — paste one JSON object per line; each key `NAME` replaces the
     `[NAME]` token in the template (e.g. `{"FILE":"src/foo.ts","TASK":"add tests"}`), so you
     can substitute several placeholders per chat.
3. **Mode & model** — pick the Copilot mode (Agent / Ask / Edit) and one of your configured
   models (or the currently active model).
4. **Launch strategy**:
   - **Sequential** — runs each chat one after another, waiting for each response (reliable).
   - **Parallel** — fires the chats with a configurable delay so sessions run concurrently
     (best‑effort; VS Code exposes no API for guaranteed parallel auto‑submit).
5. **Preview** — *Generate Preview* lists every expanded prompt with **Copy** and **Open**
   (pre‑fills a chat without submitting) buttons; *Launch All* opens them with your chosen
   strategy.

## ⚙️ Settings Reference

Global settings (namespace `customcopilot.*`):

| Setting | Default | Description |
|---|---|---|
| `customcopilot.baseUrl` | `https://router.huggingface.co/v1` | Default base URL for OpenAI‑compatible requests. |
| `customcopilot.models` | `[]` | List of model configurations (see below). |
| `customcopilot.proxyUrl` | `""` | Global proxy (`socks5://`, `http://`, `https://`). |
| `customcopilot.userAgent` | Chrome UA string | Default User‑Agent for requests. |
| `customcopilot.delay` | `0` | Fixed delay (ms) between consecutive requests. |
| `customcopilot.retry` | enabled, 3 attempts | Retry policy for transient errors (429/5xx). |
| `customcopilot.logLevel` | `off` | File log level → `~/.copilot/customcopilot/logs/`. |
| `customcopilot.commitLanguage` | `English` | Language for generated commit messages. |
| `customcopilot.commitMessagePrompt` | `""` | Custom system prompt for commit messages. |
| `customcopilot.readFileLines` | `0` | Lines to read for the `read_file` tool (0 = model decides). |

### Per‑model fields (`customcopilot.models[]`)

- `id` *(required)* — model identifier.
- `owned_by` / `provider` / `provide` *(required)* — provider id used for API‑key grouping.
- `displayName` — name shown in the Copilot model picker.
- `configId` — distinguishes multiple configs of the same `id` (`<id>::<configId>`).
- `family` — model family for behavior hints (default `oai-compatible`).
- `baseUrl`, `proxyUrl`, `userAgent` — per‑model overrides of the global values.
- `context_length` *(default 128000)*, `max_tokens` / `max_completion_tokens` *(default 4096)*.
- `vision` *(default false)* — image input support.
- `temperature` *(0–2, default 0)*, `top_p`, `top_k`, `min_p`.
- `frequency_penalty`, `presence_penalty`, `repetition_penalty`.
- `reasoning_effort` — `max` | `xhigh` | `high` | `medium` | `low` | `minimal`.
- `reasoning` — OpenRouter‑style object (`enabled`, `effort`, `exclude`, `max_tokens`).
- `thinking` — `{ "type": "enabled" | "disabled" }` (Zai‑style).
- `enable_thinking`, `thinking_budget` — toggle/limit chain‑of‑thought output.
- `include_reasoning_in_request` — echo `reasoning_content` back in assistant messages.
- `headers` — custom HTTP headers. `extra` — extra request‑body params.
- `apiMode` — `openai` | `openai-responses` | `ollama` | `anthropic` | `gemini`.
- `delay` — per‑model request delay (ms). `useForCommitGeneration` — use for commit messages.

## 🧑‍💻 Commands

| Command | ID |
|---|---|
| Set API Key For Source | `customcopilot.setProviderApikey` |
| Open Configuration UI | `customcopilot.openConfig` |
| Generate Commit Message | `customcopilot.generateGitCommitMessage` |
| Stop Commit Message Generation | `customcopilot.abortGitCommitMessage` |

## 🏗 Development

```bash
npm install          # install dependencies
npm run watch        # tsc --watch (used by the F5 dev host)
npm run compile      # one‑off build → out/
npm run lint         # eslint src
npm run format       # prettier --write .
npm run test         # compile + @vscode/test-electron
npm run build        # package → extension.vsix
```

Press `F5` to launch the Extension Development Host. See [AGENTS.md](AGENTS.md) for architecture
and contribution conventions.

## 🙏 Credits

- [Hugging Face VS Code Chat Extension](https://github.com/huggingface/huggingface-vscode-chat)
- [oai-compatible-copilot by JohnnyZ93](https://github.com/JohnnyZ93/oai-compatible-copilot)
- [microsoft/vscode](https://github.com/microsoft/vscode)
- [VS Code Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Contributors](https://github.com/keklick1337/custom-copilot/graphs/contributors)

## 📄 License

[MIT](LICENSE) © keklick1337
