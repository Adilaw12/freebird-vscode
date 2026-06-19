# Copilot throttled your speed? Switch to Freebird AI.

[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-v0.5.1-0066B8?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=TenLabs.freebird-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://github.com/Adilaw12/freebird-vscode/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Adilaw12%2Ffreebird--vscode-181717?style=flat-square&logo=github)](https://github.com/Adilaw12/freebird-vscode)

![Freebird AI — codebase-aware agent with inline edit](media/banner.png)

---

## The Problem

Copilot is great — until you hit your monthly high-speed limit and get downgraded to a slow, basic model. Suddenly your AI assistant can barely keep up.

## The Solution

Don't wait for your billing to reset. Install Freebird AI and instantly get **5 advanced cloud edits per day** — codebase search, multi-file editing, inline rewrites, AI commits, and more. Need more? **Upgrade to Pro ($6/mo)** to plug in your own API keys (BYOK) for **unlimited, unthrottled, fast refactoring**. If you run out of cash, fall back to **unlimited local Ollama (Llama 3) for free**.

**[Upgrade to Pro — $6/month](https://buy.stripe.com/4gMeVf1K51ZA2604KxfAc02)**

---

## Free vs Pro

| Feature | Free | Pro ($6/mo) |
|---|:---:|:---:|
| AI chat (unlimited questions) | ✅ | ✅ |
| Active file + `@` file context | ✅ | ✅ |
| `/` slash commands | ✅ | ✅ |
| Unlimited local Ollama — Llama 3 (100% private) | ✅ | ✅ |
| **Advanced cloud edits (codebase search, multi-file editing, inline edit, terminal, AI commit)** | 5/day | **Unlimited** |
| **Seamless Ollama fallback when cloud edits run out** | ✅ | — |
| **Bring your own API keys — BYOK (Anthropic / OpenAI)** | — | ✅ |
| **Direct-to-LLM speed & total data privacy** | — | ✅ |
| **Project memory across sessions** | — | ✅ |

> **Pro tip (BYOK):** Connect your DeepSeek API key. It scores higher than GPT-4o on coding benchmarks but costs less than **$0.20 per million tokens**. You can run thousands of unthrottled advanced edits a month for just a couple of dollars.

---

## Pick the Right Model for the Job

| Model | Best for | Cost |
|---|---|---|
| **DeepSeek Coder V2** | Fast coding, debugging, and everyday edits | ~$0.14/M tokens |
| **Qwen 2.5 Coder** | Programming speed and accuracy | ~$0.16/M tokens |
| **Claude 3.5 Sonnet** | Complex refactoring & system architecture | ~$3/M tokens |
| **GPT-4o** | Best all-rounder — code, docs, planning | ~$2.50/M tokens |
| **Ollama (Llama 3)** | Unlimited local AI — free, 100% private | Free |

All cloud models are BYOK (Pro). Ollama is always available as a free fallback.

---

## Features

![Freebird AI feature highlights](media/feature-grid.png)

### 5 Free Advanced Edits Every Day
Instantly get 5 cloud-powered agent runs per day — codebase indexing, multi-file edits, inline edit, AI commits, and more. When they run out, Freebird seamlessly switches to **unlimited local Ollama (Llama 3)** so you're never blocked. Resets daily, no card required.

### Bring Your Own Keys — Unthrottled (Pro)
Plug in your own **Anthropic Claude** or **OpenAI** API key for unlimited, unthrottled refactoring. Direct-to-LLM speed, total data privacy, no middleman quotas.

### Unlimited Local Fallback — Always Free
Run out of cloud edits? Out of budget? Freebird seamlessly falls back to **Ollama (Llama 3)** running on your machine. Unlimited, 100% private, zero cost. No one can throttle your local AI.

### Understands Your Whole Codebase
Freebird indexes your workspace and reads any file on demand. Ask it to refactor a module, trace a bug across files, or add a feature — it reads the relevant files first, then makes targeted edits with your approval.

### Makes Real Code Changes
The AI creates and edits files directly in your workspace. Every write, edit, or destructive action shows an **Approve / Reject** card — nothing is modified silently.

### Inline Edit — Cursor-style
Select any code, press `Ctrl+Alt+K`, type an instruction, and the selection is rewritten in place.

### Smart Chat
Ask anything about your code. Type `@filename` to inject any file into the conversation. Type `/` to see all available commands.

### Git Integration
Generate commit messages, push to remote, and check git status — all from the chat panel.

### Project Memory (Pro)
Freebird saves notes about your project — conventions, decisions, in-progress work — to `.freebird/memory.md` and loads them automatically on future requests. Use `/memory` to see what's saved and `/forget` to clear it.

---

## Getting Started

### Option 1 — Ollama (free, runs locally — zero setup)

1. Open Freebird AI chat (`Ctrl+Alt+O`)
2. If Ollama isn't installed, Freebird will **automatically download and install it** for you
3. The default coding model (`qwen2.5-coder`) is pulled automatically — no manual setup needed

Already have Ollama? Freebird detects it and connects instantly.

### Option 2 — Anthropic Claude (Pro, BYOK)

1. Get an API key at [console.anthropic.com](https://console.anthropic.com)
2. Run **Freebird: Configure AI Backend** from the Command Palette
3. Select **Anthropic Claude** and paste your API key.

### Option 3 — OpenAI (Pro, BYOK)

1. Get an API key at [platform.openai.com](https://platform.openai.com)
2. Run **Freebird: Configure AI Backend** from the Command Palette
3. Select **OpenAI** and paste your API key.

### Option 4 — DeepSeek Coder V2 (Pro, BYOK)

1. Get an API key at [platform.deepseek.com](https://platform.deepseek.com)
2. Run **Freebird: Configure AI Backend** → select **DeepSeek Coder V2** and paste your key.

### Option 5 — Qwen 2.5 (Pro, BYOK)

1. Get an API key at [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com)
2. Run **Freebird: Configure AI Backend** → select **Qwen 2.5** and paste your key.

---

## Commands

| Command | Shortcut | Description |
|---|---|---|
| Freebird: Open Chat | `Ctrl+Alt+O` | Open the AI chat panel |
| Freebird: Edit with AI | `Ctrl+Alt+K` | Inline rewrite selected code |
| Freebird: AI Commit | — | Generate a commit message |
| Freebird: Configure AI Backend | — | Switch between Ollama / Claude / OpenAI / DeepSeek / Qwen |
| Freebird: Activate Pro License | — | Enter your Pro license key |

### Chat Commands

| Command | Description |
|---|---|
| `/commit` | Generate a commit message |
| `/push` | Push to remote |
| `/status` | Show git status |
| `/memory` | Show what Freebird remembers about this project |
| `/forget` | Clear project memory |
| `/clear` | Clear conversation history |
| `/help` | Show all commands |

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

## Settings

| Setting | Default | Description |
|---|---|---|
| `freebird.backend` | `ollama` | AI backend: `ollama`, `anthropic`, `openai`, `deepseek`, `qwen` |
| `freebird.apiKey` | *(empty)* | API key for cloud backends (Anthropic, OpenAI, DeepSeek, Qwen) |
| `freebird.model` | *(auto)* | Override the default model |
| `freebird.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `freebird.licenseKey` | *(empty)* | Pro license key |

**Default models per backend:**

| Backend | Default model | Override for heavy tasks |
|---|---|---|
| Ollama | `qwen2.5-coder` | — |
| Anthropic | `claude-haiku-4-5` | `claude-sonnet-4-6` (complex refactoring) |
| OpenAI | `gpt-4o-mini` | `gpt-4o` (all-rounder) |
| DeepSeek | `deepseek-coder-v2` | — |
| Qwen | `qwen2.5-coder-32b-instruct` | — |

See the [model guide](#pick-the-right-model-for-the-job) above to choose the best model for your task.

---

## Privacy

- **Ollama**: all processing is local — no data leaves your machine.
- **Anthropic / OpenAI**: your code is sent to their APIs under your own account.
- **Freebird AI** (Ten Labs Pty. Limited) never collects or stores any of your code or data.

---

## Support

Having trouble with a payment, license activation, or anything else? Email **[support@ten-labs.com.au](mailto:support@ten-labs.com.au)** and we'll help you out.

---

## Contributing

Freebird AI is open source. Issues and PRs welcome at the [GitHub repository](https://github.com/Adilaw12/freebird-vscode).

---

## License

MIT — Copyright © 2025 Ten Labs Pty. Limited
