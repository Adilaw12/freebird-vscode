# The AI coding assistant that just works - no setup, no throttling.

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-v0.6.8-0066B8?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=TenLabs.freebird-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://github.com/Adilaw12/freebird-vscode/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Adilaw12%2Ffreebird--vscode-181717?style=flat-square&logo=github)](https://github.com/Adilaw12/freebird-vscode)

![Freebird AI - codebase-aware agent with inline edit](media/banner.png)

---

Install Freebird AI and start coding in seconds. No API keys. No Ollama. No configuration. Just **5 free advanced edits per day** powered by Gemini Flash, and unlimited local AI when you want full privacy.

Copilot throttled? GitHub limits hit? **Don't wait for your billing to reset** - Freebird picks up where they left off. Upgrade to Pro ($6 USD/mo) and plug in your own API keys for unlimited, unthrottled refactoring at a fraction of the cost.

[**Start free — upgrade anytime for $6 USD/month →**](https://buy.stripe.com/9B628t4WheMmeSMccZfAc03)

---

## Free vs Pro

|Feature|Free|Pro ($6 USD/mo)|
|-|:-:|:-:|
|AI chat (unlimited questions)|✅|✅|
|Active file + `@` file context|✅|✅|
|`/` slash commands|✅|✅|
|**Works instantly — no setup required**|✅|✅|
|Unlimited local Ollama (100% private)|✅|✅|
|**Advanced cloud edits (codebase search, multi-file editing, inline edit, terminal, AI commit)**|5/day|**Unlimited**|
|**Gemini Flash fallback when Ollama is unavailable**|✅|—|
|**Bring your own API keys — BYOK (Anthropic / OpenAI / DeepSeek / Qwen)**|—|✅|
|**Direct-to-LLM speed & total data privacy**|—|✅|
|**Project memory across sessions**|—|✅|

> **Pro tip:** Connect your DeepSeek API key (Pro). It scores higher than GPT-4o on coding benchmarks but costs less than **$0.20 per million tokens** — thousands of unthrottled edits per month for a couple of dollars on top of your $6 plan.

---

## See It in Action

### Multi-file agent edit with Approve / Reject

Ask Freebird to update your products page, add images to cards, or refactor across files — it shows a full diff and waits for your approval before changing anything.

![Freebird AI — multi-file agent edit with approve/reject flow](media/Freebird%20AI-%20edit%20screen.png)

### Agentic page editing across HTML and CSS

Freebird reads your existing HTML structure, understands the context, and makes targeted edits across files — CSS, HTML, and content — in one agent run.

![Freebird AI — agentic page editing across HTML and CSS](media/Freebird%20AI-%20edit%20screen-2.png)

---

## Features

![Freebird AI feature highlights](media/feature-grid.png)

### Works Immediately, No Setup Required

Open Freebird and start coding. Your first 5 advanced edits per day are powered by **Gemini Flash** — no API key, no Ollama install, nothing to configure. Just install and go.

### 5 Free Advanced Edits Every Day

Get 5 cloud-powered agent runs per day — codebase indexing, multi-file edits, inline edit, AI commits, and more. Resets daily, no card required.

### Always-On Fallback, Never Get Blocked

Run out of cloud edits? Freebird automatically falls back to **local Ollama** if you have it installed. No Ollama? Freebird still responds via Gemini Flash. You are never left with a broken tool.

### Bring Your Own Keys - Unthrottled (Pro)

Plug in your own **Anthropic Claude**, **OpenAI**, **DeepSeek**, or **Qwen** API key for unlimited, unthrottled refactoring. Direct-to-LLM speed, total data privacy, no middleman quotas.

### Understands Your Whole Codebase

Freebird indexes your workspace and reads any file on demand. Ask it to refactor a module, trace a bug across files, or add a feature — it reads the relevant files first, then makes targeted edits with your approval.

### Makes Real Code Changes — Safely

The AI creates and edits files directly in your workspace. Every write, edit, or destructive action shows an **Approve / Reject** card — nothing is modified silently.

### Inline Edit — Cursor-style

Select any code, press `Ctrl+Alt+K`, type an instruction, and the selection is rewritten in place.

### Smart Chat with File Context

Ask anything about your code. Type `@filename` to inject any file into the conversation. Type `/` to see all available commands.

### Git Integration

Generate commit messages, push to remote, and check git status — all from the chat panel.

### Project Memory (Pro)

Freebird saves notes about your project — conventions, decisions, in-progress work — to `.freebird/memory.md` and loads them automatically on future requests. Use `/memory` to see what's saved and `/forget` to clear it.

---

## Pick the Right Model for the Job

|Model|Best for|Cost|
|-|-|-|
|**Gemini Flash (built-in)**|Default free tier — fast, no setup|Free (5/day)|
|**Ollama (local)**|Unlimited local AI — free, 100% private|Free|
|**DeepSeek V4-pro**|Advanced reasoning, coding, debugging|~$0.14/M tokens|
|**Qwen 2.5 Coder**|Programming speed and accuracy|~$0.16/M tokens|
|**GPT-4o**|Best all-rounder — code, docs, planning|~$2.50/M tokens|
|**Claude Sonnet**|Complex refactoring & system architecture|~$3/M tokens|

All BYOK models require Pro. Gemini Flash and Ollama are always free.

---

## Getting Started

### Option 1 — Just Install (Recommended)

1. Install Freebird AI
2. Open the chat panel (`Ctrl+Alt+O`)
3. Start coding — Gemini Flash handles your first 5 edits per day automatically

No API keys, no Ollama, no configuration needed.

### Option 2 — Ollama (unlimited free, runs locally)

1. Install [Ollama](https://ollama.com/download)
2. Run `ollama pull qwen2.5-coder` in a terminal
3. Run **Freebird: Configure AI Backend** → select **Ollama**

### Option 3 — Anthropic Claude (Pro, BYOK)

1. Get an API key at [console.anthropic.com](https://console.anthropic.com)
2. Run **Freebird: Configure AI Backend** → select **Anthropic Claude** and paste your key

### Option 4 — OpenAI (Pro, BYOK)

1. Get an API key at [platform.openai.com](https://platform.openai.com)
2. Run **Freebird: Configure AI Backend** → select **OpenAI** and paste your key

### Option 5 — DeepSeek (Pro, BYOK)

1. Get an API key at [platform.deepseek.com](https://platform.deepseek.com)
2. Run **Freebird: Configure AI Backend** → select **DeepSeek** and paste your key

### Option 6 — Qwen 2.5 (Pro, BYOK)

1. Get an API key at [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com)
2. Run **Freebird: Configure AI Backend** → select **Qwen 2.5** and paste your key

---

## Commands

|Command|Shortcut|Description|
|-|-|-|
|Freebird: Open Chat|`Ctrl+Alt+O`|Open the AI chat panel|
|Freebird: Edit with AI|`Ctrl+Alt+K`|Inline rewrite selected code|
|Freebird: AI Commit|—|Generate a commit message|
|Freebird: Configure AI Backend|—|Switch between Gemini / Ollama / Claude / OpenAI / DeepSeek / Qwen|
|Freebird: Activate Pro License|—|Enter your Pro license key|

### Chat Commands

|Command|Description|
|-|-|
|`/commit`|Generate a commit message|
|`/push`|Push to remote|
|`/status`|Show git status|
|`/memory`|Show what Freebird remembers about this project|
|`/forget`|Clear project memory|
|`/clear`|Clear conversation history|
|`/help`|Show all commands|

---

## How the Agent Works

When you ask Freebird to perform a task, it runs an agent loop — similar to Cursor Composer:

1. **Reads** your workspace file tree automatically
2. **Fetches** specific files it needs
3. **Searches** the codebase for symbols, patterns, or text
4. **Edits** files with targeted diffs — Approve / Reject before anything changes
5. **Creates** new files — preview shown before creation
6. **Runs** terminal commands — shown before execution
7. **Commits and pushes** — requires your explicit approval

Nothing is modified silently. You stay in full control.

---

## Customizing Model Versions

All cloud backends support model overrides via the `freebird.model` setting.

**Via `.vscode/settings.json`:**

```json
{
  "freebird.backend": "deepseek",
  "freebird.apiKey": "your-api-key-here",
  "freebird.model": "deepseek-coder"
}
```

|Backend|Default model|Alternative|
|-|-|-|
|Gemini Flash (cloud)|`gemini-2.0-flash`|—|
|Ollama|`qwen2.5-coder`|any Ollama model|
|Anthropic|`claude-haiku-4-5`|`claude-sonnet-4-6` (complex tasks)|
|OpenAI|`gpt-4o-mini`|`gpt-4o`|
|DeepSeek|`deepseek-reasoner`|`deepseek-coder`|
|Qwen|`qwen2.5-coder-32b-instruct`|—|

---

## Settings

|Setting|Default|Description|
|-|-|-|
|`freebird.backend`|`cloud`|AI backend: `cloud`, `ollama`, `anthropic`, `openai`, `deepseek`, `qwen`|
|`freebird.apiKey`|*(empty)*|API key for BYOK backends|
|`freebird.model`|*(auto)*|Override the default model|
|`freebird.ollamaUrl`|`http://localhost:11434`|Ollama server URL|
|`freebird.licenseKey`|*(empty)*|Pro license key|
|`freebird.telemetry.enabled`|`true`|Anonymous usage analytics (no code/PII collected)|

---

## Privacy

* **Gemini Flash (free tier)**: messages processed by Google's API. No code stored by Freebird.
* **Ollama**: all processing is local — no data leaves your machine.
* **Anthropic / OpenAI / DeepSeek / Qwen**: code sent to their APIs under your own account.
* **Freebird AI** (Ten Labs Pty. Limited) never collects or stores your code or conversation data.

---

## Support

Having trouble with a payment, license activation, or anything else? Email [**support@ten-labs.com.au**](mailto:support@ten-labs.com.au) and we'll sort it out.

---

## Contributing

Freebird AI is open source. Issues and PRs welcome at the [GitHub repository](https://github.com/Adilaw12/freebird-vscode).

---

## License

MIT — Copyright © 2025 Ten Labs Pty. Limited
