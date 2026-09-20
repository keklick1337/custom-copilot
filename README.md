<div align="center">

<img src="https://raw.githubusercontent.com/keklick1337/custom-copilot/master/assets/logo.png" alt="Copilot Custom Models Endpoint" width="120" />

# Copilot Custom Models Endpoint

**Bring any OpenAI‑compatible, Ollama, Anthropic, Gemini, or Z.AI endpoint to GitHub Copilot Chat.**

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=keklick1337.keklick-copilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

This extension registers a **Language Model Chat Provider** for GitHub Copilot Chat. It lets
you add your own models — from a self‑hosted server, a cloud OpenAI‑compatible router, a local
Ollama install, or the native Anthropic / Gemini / Z.AI APIs — and use them directly inside the
Copilot Chat model picker, with full support for tools, vision, and reasoning/thinking output.

> **Bring Your Own Key (BYOK).** You supply the endpoint and API key; nothing is proxied
> through any third party. A built‑in privacy default disables VS Code telemetry on first run
> so the names of the models/providers you use are not reported.

## ✨ Highlights

- **Six API modes** — `openai` (Chat Completions), `openai-responses`, `ollama`,
  `anthropic`, `gemini`, and `zai` (Z.AI / Anthropic‑compatible with Bearer auth).
  One `apiMode` switch per model picks the adapter.
- **Visual configuration panel** — a dedicated activity‑bar sidebar to add providers,
  fetch models, and tune parameters without hand‑editing JSON.
- **40+ provider presets** — grouped picker (First‑party, GLM / Z.AI, Aggregators, Regional
  clouds, Local / self‑hosted) covering OpenAI, Anthropic, Gemini, xAI, OpenRouter, Nous
  Portal, HuggingFace Router, Vercel AI Gateway, Groq, Together, Fireworks, DeepInfra,
  Novita, Nebius, NVIDIA NIM, DeepSeek, DashScope/Qwen, Moonshot, Mistral, Perplexity,
  Cerebras, StepFun, Xiaomi MiMo, ModelScope, SiliconFlow, Upstage, GMI, Arcee, Ollama
  (local + cloud), LM Studio, vLLM, llama.cpp, SGLang, and more. Each preset auto‑fills the
  base URL and `apiMode`; a custom URL can always be typed instead.
- **Automatic capability detection** — when you fetch models from a `/v1/models` endpoint,
  vision, tool‑calling, context length, and reasoning are inferred from the endpoint fields,
  with sensible model‑id heuristics and safe fallbacks.
- **Tools, vision & thinking** — function calling (including parallel tool calls), image
  input, and reasoning/“thinking” blocks are surfaced in Copilot Chat where the model
  supports them. Streaming assembly is per‑tool‑call‑index, so parallel tool calls are
  emitted correctly.
- **Context‑usage circle** — token usage reported by your provider (prompt/completion/
  cached/reasoning tokens, per protocol) feeds Copilot Chat's context‑usage indicator, so
  the circle next to the chat input populates for custom models just like for Copilot's own.
- **Reasoning‑effort normalization** — `reasoning_effort` is clamped onto each provider's
  supported vocabulary (never escalating cost): the OpenAI‑compatible wire tops out at
  `max`, GLM‑5.2 accepts `high`/`max`, GLM‑5.3 `low`–`max`, Groq gets `default`, Gemini 3
  maps to `thinkingLevel`. Thinking budgets are validated against output ceilings
  (Anthropic `max_tokens` is raised to `budget + 4096`; Gemini `maxOutputTokens` to 65535
  when thinking is on) so a model never "thinks past its tokens" and 400s.
- **Multi‑provider & multi‑config** — group models by provider with per‑provider API keys,
  and define the same model id multiple times with different settings via `configId`.
  Duplicate ids are auto‑assigned a numeric `configId` (`::1`, `::2`, …) when added
  through the configuration UI, and a one‑time migration assigns them to existing
  duplicates on first launch.
- **Multi‑key load balancing** — a provider can hold a pool of API keys (one per line);
  requests are balanced round‑robin, failing keys rotate silently and are temporarily
  benched, benched keys rejoin automatically as their error score decays.
- **Remote key sources** — instead of inline keys, point a provider at a file or URL that
  returns a key list; it is fetched fresh on every request so rotated keys are picked up
  automatically.
- **Proxy support everywhere** — route ALL provider traffic (chat, model discovery, key
  tests, commit generation, remote key fetches) through `socks5://`, `socks5h://`,
  `http://`, or `https://` proxies, globally (`customcopilot.proxyUrl`) or per‑model
  (`proxyUrl`). SOCKS5h (remote DNS) is auto‑normalised to SOCKS5; `direct` / `none`
  forces a direct connection even when a global proxy is set.
- **Git commit messages** — generate SCM commit messages from your own model, in any API
  mode (including Gemini and Z.AI).
- **Persistent chat sessions** — keep and restore your chat history across full VS Code
  restarts (`chat.restoreLastPanelSession`), even when using Copilot without a GitHub account.
- **Chat Generator** — turn one prompt template into many Copilot chats at once: substitute a
  per‑line value (`[REPLACE_THAT]`) or JSONL patterns (`[KEY]`), pick the mode and model, and
  launch the sessions sequentially or in parallel.
- **Per‑model control** — base URL, proxy, User‑Agent (with presets + 🎲 random), headers,
  extra body params, temperature, top‑p/k, penalties, reasoning effort, thinking budget,
  request delay, and retry.
- **Cross‑vendor model compatibility** — model ids are namespaced with a `provider:index:`
  prefix internally so they never collide with or hide built‑in Copilot models of the same
  name (e.g. your `claude-opus-5` and Copilot's `claude-opus-5` both appear in the picker).
- **Fetch‑model search filter** — when fetching 500+ models from an API, a live search box
  filters the results by substring (e.g. type `glm` to see only GLM models).
- **Local token counting** — usage is estimated locally with the bundled `o200k_base`
  tokenizer; a failed tokenizer init retries instead of silently reporting 0 forever.
- **Privacy‑conscious logging** — full conversation dumps require an explicit opt‑in
  (`customcopilot.logMessageContent`); header values are masked denylist‑by‑default in the
  curl‑reproduction debug output, so custom auth headers never leak into logs.

## 📦 Requirements

- VS Code **1.134.0** or newer.
- GitHub Copilot Chat installed.
- An endpoint URL and (usually) an API key.

> **ℹ️ Proposed API note.** This extension uses the `chatProvider` proposed API.  VS Code logs a
> warning (`CANNOT USE these API proposals 'chatProvider'`) if the extension isn't in VS Code's
> pre-approved allowlist, but this is **non-blocking** — the extension only uses the proposed API
> for model registration, not for the gated enhanced capabilities (`editTools`, `isDefault`,
> `requiresAuthorization`).  Models appear in the picker and chat works normally without any
> extra flags.  If you want to silence the warning, launch with:
>
> ```
> code --enable-proposed-api=keklick1337.keklick-copilot
> ```

## 🚀 Install & First Run

1. Install **Copilot Custom Models Endpoint** from the Marketplace (or `code --install-extension extension.vsix`).
2. Open the **Custom Copilot** view from the activity bar (the sidebar icon) to open the
   configuration panel.
3. Add a provider: pick a **preset** from the grouped Quick‑Setup dropdown (or type a custom
   base URL), then fetch the model list or add models manually.
4. Set the provider's API key when prompted, or run **Custom Copilot: Set API Key For Source**
   from the Command Palette.
5. In Copilot Chat, open the model picker → **Manage Models…** → choose **CustomCopilot**, and
   enable the models you want.

> **Using Copilot Chat without a GitHub account.** This extension registers BYOK (Bring Your
> Own Key) models, which normally lets you use Copilot Chat while signed out of GitHub.  On
> first launch, the extension attempts to create provider groups in VS Code's language-models
> config automatically (via the `lm.addLanguageModelsProviderGroup` command).  If that fails
> (e.g. the command isn't available in your VS Code version), you can do it manually: in
> Copilot Chat → model picker → **Manage Models…** → select one of the Custom providers →
> **Configure** → enter the base URL → save.  Once a provider group exists, the "Sign in to
> use Copilot" gate disappears and you can chat with your own models without a GitHub account.

## 🛠 Configuration UI

The configuration panel is a webview hosted in its own activity‑bar container. From it you can:

- **Providers** — add/edit providers, set base URL / proxy / User‑Agent, and **Fetch from API**
  to import models (capabilities are auto‑detected). When adding a new provider, pick from
  40+ **built‑in presets** grouped by category (First‑party, GLM / Z.AI, Aggregators, Regional
  clouds, Local / self‑hosted) that auto‑fill the base URL and `apiMode` — or type your own URL.
- **API keys** — paste keys inline (one per line to load‑balance a pool) or point at a
  **file/URL key source** fetched fresh per request. A **Test keys** button sends a probe
  request with each key and shows per‑key ✓/✗.
- **Proxy** — configure a global proxy (`customcopilot.proxyUrl`) or per‑model proxy
  (`proxyUrl` on a model entry). Supports `socks5://`, `socks5h://` (remote DNS, auto‑normalised
  to SOCKS5), `http://`, and `https://` schemes; `direct` opts a model out of the global proxy.
- **Global Settings** — toggle privacy‑ and persistence‑related options:
  - **Use Copilot Chat without a GitHub account** — since this extension registers BYOK
    models, Copilot Chat works while signed out of GitHub out of the box; no extra setting is
    needed. The toggle also sets VS Code's experimental `chat.allowAnonymousAccess` (hidden,
    experiment‑gated, may be unavailable in some VS Code versions) for advanced scenarios.
  - **Save & restore chat sessions across restarts** (`chat.restoreLastPanelSession`) — keep
    your last chat after VS Code is fully restarted, even without a GitHub account.
  - **Disable telemetry** (`telemetry.telemetryLevel`), which is also set off on first run.
  - **Automatic chat retries** (`customcopilot.chatRetries` / `chatRetryInterval` /
    `chatRetryJitter`) — auto "Try Again" on failed requests; `0` off, `-1` infinite, or a
    max attempt count with optional jitter.
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
| `openai` *(default)* | `POST {baseUrl}/chat/completions` | Standard OpenAI Chat Completions. Usage stats requested via `stream_options.include_usage`. |
| `openai-responses` | `POST {baseUrl}/responses` | OpenAI Responses API; reasoning summaries, stateful `previous_response_id` reuse with automatic fallback for gateways that don't support it. |
| `ollama` | `POST {baseUrl}/api/chat` | Local Ollama; API key optional. |
| `anthropic` | `POST {baseUrl}/v1/messages` | Native Anthropic Messages API; strict role alternation enforced, thinking blocks replayed safely. |
| `gemini` | `POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse` | Native Google Gemini API. |
| `zai` | `POST {baseUrl}/v1/messages` | Z.AI (Anthropic‑compatible, Bearer auth, GLM reasoning_effort mapping). |

Each mode converts messages, tools, images, and thinking blocks to the provider's native
format, and reports token usage back to Copilot Chat.

## 👥 Multi‑Provider

`owned_by` (aliases: `provider` / `provide`) groups models by provider. Each provider gets its
own API key stored as the secret `customcopilot.apiKey.<providerLowercase>`. Use
**Custom Copilot: Set API Key For Source** to set them. There is no global/default API key —
every model authenticates with its provider's key.

```jsonc
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

## 🔑 Multi‑Key Load Balancing & Remote Key Sources

A provider can hold **multiple API keys** — enter one key per line in the **API Key(s)** field
of the configuration UI (they are stored newline‑separated under the same
`customcopilot.apiKey.<providerLowercase>` secret, so a single key keeps working unchanged).

When more than one key is present, every chat request is balanced across the pool:

- Requests are spread round‑robin over the healthiest keys.
- If a key errors (rate limit, auth, network, 5xx) the request silently rotates to another key —
  no error is surfaced while a healthy key remains.
- Failing keys accumulate an error score and are **temporarily benched** once they get much worse
  than the others; the score decays over time so a benched key automatically rejoins.
- The **Chat Generator** runs in parallel across the pool, distributing load over all keys.

Alternatively, set a **key source** (a file path or URL returning a key list). The source is
fetched fresh on every request — rotated keys are picked up automatically without reloading
VS Code — and requests to the source itself also honour the proxy configuration.

When you **Fetch models** for a multi‑key provider, only the models available on **every** key are
shown (the intersection), and a per‑key ✓/✗ summary reports which keys authenticated.

## 🧩 Multi‑Config (same model, different settings)

Use `configId` to register the same model id with different settings. Each entry appears
separately in the model picker as `<id>::<configId>`.

When you add a model through the configuration UI whose `id` already exists, a `configId` is
**auto‑generated** (`1`, `2`, …) so you don't have to set it manually. Existing duplicates in
your config are migrated automatically on first launch after updating the extension.

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

> **Cross‑vendor compatibility:** Model ids returned to VS Code carry a `provider:index:`
> prefix internally (e.g. `zai:0:glm-4.6`) so they never collide with built‑in Copilot models
> of the same name. The prefix is transparent — the picker shows the display name, and the
> API receives the bare `id`.

## 🧠 Thinking & Reasoning

Per‑model fields control chain‑of‑thought behaviour across all adapters:

- `enable_thinking` / `thinking: { "type": "enabled" | "disabled" }` — master toggle.
- `thinking_budget` — token budget for reasoning (Anthropic `budget_tokens`, Gemini
  `thinkingBudget`).
- `reasoning_effort` — effort level, **automatically clamped** to each provider's supported
  vocabulary so an unsupported value never 400s: OpenAI‑compatible wire (`minimal`…`max`),
  GLM‑5.2 (`high`/`max`), GLM‑5.3 (`low`–`max`), Groq (`default`), Gemini 3
  (`thinkingLevel` low/medium/high, stricter for Pro).
- Safety rails: with thinking enabled, output ceilings are raised so reasoning never starves
  the visible answer — Anthropic `max_tokens ≥ budget + 4096`, Gemini `maxOutputTokens`
  raised to 65535 (gemini‑family models only; Gemma never receives `thinkingConfig`, which
  its API rejects).
- `include_reasoning_in_request` — echo reasoning back in assistant history (actual thinking
  only; nothing is fabricated).
- Inline `<think>…</think>` blocks emitted by OpenAI‑compatible models are detected with a
  chunk‑boundary‑safe streaming parser and surfaced as native thinking parts.

## 🧷 Custom Headers

`headers` adds custom HTTP headers to every request for a model. They are merged with the
default headers (`Authorization`, `Content-Type`, `User-Agent`) and take precedence on conflict.
Header values are masked in debug logs unless on a known‑safe list.

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

`extra` values override standard parameters on conflict, so prefer the dedicated fields where
they exist.

## 🧰 Git Commit Messages

Mark a model with `"useForCommitGeneration": true`, then use the **Generate Commit Message**
button in the Source Control title bar (or the command of the same name). The output language is
controlled by `customcopilot.commitLanguage`, and you can override the prompt with
`customcopilot.commitMessagePrompt`. Works in **all** API modes, including `gemini` and `zai`.

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
| `customcopilot.chatRetries` | `0` | Automatic chat-level retries ("auto Try Again") when a request fails before any content streams. `0` off, `-1` infinite, `N` max attempts. |
| `customcopilot.chatRetryInterval` | `1000` | Delay (ms) between automatic chat-level retries. |
| `customcopilot.chatRetryJitter` | `0` | Optional random extra delay (0–N ms) added before each chat retry, spreading out batch retries. `0` disables. |
| `customcopilot.logLevel` | `off` | File log level → `~/.copilot/customcopilot/logs/`. |
| `customcopilot.logMessageContent` | `false` | Privacy opt‑in: when enabled AND `logLevel` is `debug`, full chat message content is written to the log file. Keep disabled unless you explicitly want conversation content persisted to disk. |
| `customcopilot.debugRequestLogging` | `false` | Detailed curl‑reproduction + response logging of failed requests (headers masked). |
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
- `reasoning_effort` — `max` | `xhigh` | `high` | `medium` | `low` | `minimal` (auto‑clamped per provider).
- `reasoning` — OpenRouter‑style object (`enabled`, `effort`, `exclude`, `max_tokens`).
- `thinking` — `{ "type": "enabled" | "disabled" }` (Zai‑style).
- `enable_thinking`, `thinking_budget` — toggle/limit chain‑of‑thought output.
- `include_reasoning_in_request` — echo `reasoning_content` back in assistant messages.
- `headers` — custom HTTP headers. `extra` — extra request‑body params.
- `apiMode` — `openai` | `openai-responses` | `ollama` | `anthropic` | `gemini` | `zai`.
- `delay` — per‑model request delay (ms). `useForCommitGeneration` — use for commit messages.
- Auto‑generated: `configId` is auto‑assigned (`1`, `2`, …) when a model with the same `id`
  already exists and no explicit `configId` is set. Existing duplicates are migrated on first
  launch.

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
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — provider reasoning‑effort
  vocabularies and thinking‑budget safety patterns were ported from its provider registry.
- [VS Code Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [Contributors](https://github.com/keklick1337/custom-copilot/graphs/contributors)

## 📄 License

[MIT](LICENSE) © keklick1337
