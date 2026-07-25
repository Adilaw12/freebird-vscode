# Freebird AI — AI Coding Assistant for VS Code

**No setup. No throttling. 20 free AI edits/day.**

[![VS Marketplace](https://vsmarketplacebadges.dev/version/TenLabs.freebird-ai.svg?subject=VS%20Marketplace&color=0066B8&style=flat-square)](https://marketplace.visualstudio.com/items?itemName=TenLabs.freebird-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](https://github.com/Adilaw12/freebird-vscode/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Adilaw12%2Ffreebird--vscode-181717?style=flat-square&logo=github)](https://github.com/Adilaw12/freebird-vscode)

> AI coding assistant · Copilot alternative · Cursor alternative · multi-file AI edits · AI refactoring · codebase search · Gemini Flash · Ollama · BYOK · local AI · privacy-first

![Freebird AI — codebase-aware agent with inline edit](media/banner.png)

Install Freebird AI and start coding in seconds — no API keys, no throttling, no configuration. You get **20 free advanced AI edits per day** powered by Gemini Flash, plus free BYOK and unlimited local AI when you want full privacy.

**Copilot throttled? Cursor too expensive? GitHub limits hit?**
Freebird never blocks you — it picks up where other tools stop.

**[Upgrade to Pro — $6 USD/month →](https://buy.stripe.com/9B628t4WheMmeSMccZfAc03)** · or start a **free 7-day Pro trial** (no card needed) right from the chat panel

⭐ **If Freebird saves you time, a GitHub star helps others find it** — thank you!

---

## Why Freebird

| | Copilot | Cursor | Freebird Free | Freebird Pro |
|---|:---:|:---:|:---:|:---:|
| Price | $10/mo | $20/mo | **Free** | **$6/mo** |
| Setup required | No | Yes | **No** | No |
| Multi-file agent edits (terminal, checkpoints) | Limited | ✅ | ❌ | ✅ |
| Local AI (Ollama) | ❌ | ❌ | ✅ | ✅ |
| BYOK (Claude, GPT-4o, DeepSeek, Qwen) | ❌ | ✅ | ✅ | ✅ |
| Cloud edits throttled | ✅ | ✅ | 20/day soft cap | Never |

---

## See It in Action

### Multi-file agent edit with Approve / Reject (Pro)
Ask Freebird to update your products page, add images to cards, or refactor across files — it shows a full diff and waits for your approval before changing anything.

![Freebird AI — multi-file agent edit with approve/reject flow](media/Freebird%20AI-%20edit%20screen.png)

### Agentic page editing across HTML and CSS (Pro)
Freebird reads your existing code structure, understands the context, and makes targeted edits across files in one agent run.

![Freebird AI — agentic page editing across HTML and CSS](media/Freebird%20AI-%20edit%20screen-2.png)

---

## Free vs Pro

| Feature | Free | Pro ($6 USD/mo) |
|---|:---:|:---:|
| AI chat (unlimited questions) | ✅ | ✅ |
| Active file + `@` file context | ✅ | ✅ |
| `/` slash commands | ✅ | ✅ |
| Works instantly — no setup | ✅ | ✅ |
| Unlimited local Ollama (100% private) | ✅ | ✅ |
| **Bring your own API keys — BYOK (Anthropic / OpenAI / DeepSeek / Qwen)**, direct-to-LLM speed & total privacy | ✅ | ✅ |
| Inline edit (`Ctrl+Alt+K`) & AI commit, cloud-powered | 20/day | **Unlimited** |
| **Multi-file agent edits, terminal commands, checkpoints** | — | ✅ |
| **Project memory across sessions** | — | ✅ |
| Full (non-lite) Gemini model on cloud edits | — | ✅ |

> **Pro tip:** Connect your DeepSeek API key — it's free on every plan, scores higher than GPT-4o on coding benchmarks, and costs about $0.20/million tokens. Thousands of unthrottled edits a month for pennies, no Pro required.

---

## What Freebird Replaces

- **GitHub Copilot** — when you hit your monthly speed limit
- **Cursor Composer** — multi-file agent edits, without migrating from VS Code
- **Claude Code** — the same bring-your-own-key workflow, free, without leaving VS Code
- **Local coding agents** — Ollama integration built in, unlimited and private
- **Cloud-forbidden environments** — enterprise policies that ban cloud AI, NDA-bound freelance work — Pro's Agent mode runs on Ollama with zero calls ever leaving the machine

---

## Features

![Freebird AI feature highlights](media/feature-grid.png)

### Works Immediately — No Setup Required
Install and start coding. Your first 20 advanced edits per day are powered by Gemini Flash — no API key, no Ollama, nothing to configure.

### 20 Free Advanced Edits Every Day
Unlimited chat, plus 20 cloud-powered inline edits and AI commits a day. Resets daily, no card required. Multi-file agent edits and terminal commands are Pro (see below).

### Hit Your Daily Cap? You've Got Options
If you've configured Ollama as your backend, Freebird falls back to it automatically when the cloud quota runs out. Otherwise you'll see a clear "free edits used up" prompt with a no-card 7-day Pro trial one click away — or switch to BYOK (free, unlimited) or Ollama (free, unlimited) anytime from **Freebird: Configure AI Backend**.

### Multi-File Agent Edits with Approve / Reject (Pro)
Freebird reads your codebase, fetches relevant files, and makes targeted edits across multiple paths. Every write shows an Approve / Reject card — nothing changes silently.

### Checkpoints — Undo an Entire Agent Turn (Pro)
Every Pro agent turn that creates, edits, copies, or downloads a file gets a "Checkpoint saved" card with a one-click Restore button, reverting every file that turn touched back to its state before the turn. Covers file changes; a turn that also ran a shell command or `git push` is clearly labeled as not revertible rather than pretending to cover it.

### Web Context — Read Any Page the Agent Needs (Pro)
The agent can fetch a webpage's readable content directly — documentation, an article, a URL you paste in — instead of only searching your own codebase. Requests to private/internal addresses (localhost, LAN ranges, cloud metadata endpoints) are blocked, and fetched content is explicitly marked as untrusted reference material before it ever reaches the model, so a malicious page can't pass itself off as an instruction.

### Inline Edit — Cursor-style
Select any code, press `Ctrl+Alt+K`, type an instruction, and the selection is rewritten in place.

![Freebird AI — inline edit rewriting a selection in place](media/Inline%20AI%20refactor.gif)

### Bring Your Own Keys — Unthrottled, free
Plug in your own **Anthropic Claude**, **OpenAI**, **DeepSeek**, or **Qwen** API key. Direct-to-LLM speed, total data privacy, no middleman quotas — free for everyone, since the calls never touch Freebird's servers.

### Full Agent Mode With Zero Cloud Calls (Pro)
Agent mode isn't locked to Freebird's cloud — it routes through whatever backend you've configured, same as everything else. Set the backend to **Ollama** and get the full Pro feature set (multi-file edits, terminal commands, checkpoints, project memory) with every request staying on your machine. Built for teams whose policy forbids cloud AI, or freelancers working under an NDA that does the same — the model runs locally, so there's nothing to disclose.

### Smart Chat with File Context
Type `@filename` to inject any file into the conversation. Type `/` to see all available commands.

### Git Integration
Generate commit messages, push to remote, check git status — all from the chat panel.

### Project Memory (Pro)
Freebird saves notes about your project to `.freebird/memory.md` and loads them automatically. Use `/memory` to see what's saved and `/forget` to clear it.

---

## Pick the Right Model

| Model | Best for | Cost |
|---|---|---|
| **Gemini Flash (built-in)** | Default free tier — fast, no setup | Free (20/day) |
| **Ollama (local)** | Unlimited local AI — free, 100% private | Free |
| **DeepSeek V4-pro** | Advanced reasoning, coding, debugging | ~$0.14/M tokens |
| **Qwen 2.5 Coder** | High-accuracy coding | ~$0.16/M tokens |
| **GPT-4o** | Best all-rounder | ~$2.50/M tokens |
| **Claude Sonnet** | Complex refactoring & architecture | ~$3/M tokens |

BYOK models are free for everyone (bring your own API key/cost). Gemini Flash and Ollama are also always free. Pro adds Agent mode (multi-file edits, terminal, checkpoints) and unlimited cloud edits on the full Gemini model.

---

## Getting Started

### Option 1 — Just Install (Recommended)
1. Install Freebird AI
2. Open chat (`Ctrl+Alt+O`)
3. Start coding — 20 free AI edits/day, no setup needed

### Option 2 — Ollama (Unlimited Free, Local)
1. Install [Ollama](https://ollama.com/download)
2. Run `ollama pull qwen2.5-coder` in a terminal
3. Run **Freebird: Configure AI Backend** → select **Ollama**

### Option 3 — Anthropic Claude (BYOK, free)
1. Get an API key at [console.anthropic.com](https://console.anthropic.com)
2. Run **Freebird: Configure AI Backend** → select **Anthropic Claude**

### Option 4 — OpenAI (BYOK, free)
1. Get an API key at [platform.openai.com](https://platform.openai.com)
2. Run **Freebird: Configure AI Backend** → select **OpenAI**

### Option 5 — DeepSeek (BYOK, free)
1. Get an API key at [platform.deepseek.com](https://platform.deepseek.com)
2. Run **Freebird: Configure AI Backend** → select **DeepSeek**

### Option 6 — Qwen 2.5 (BYOK, free)
1. Get an API key at [dashscope.console.aliyun.com](https://dashscope.console.aliyun.com)
2. Run **Freebird: Configure AI Backend** → select **Qwen 2.5**

---

## Commands

| Command | Shortcut | Description |
|---|---|---|
| Freebird: Open Chat | `Ctrl+Alt+O` | Open the AI chat panel |
| Freebird: Edit with AI | `Ctrl+Alt+K` | Inline rewrite selected code |
| Freebird: AI Commit | — | Generate a commit message |
| Freebird: Configure AI Backend | — | Switch between Gemini / Ollama / Claude / OpenAI / DeepSeek / Qwen |
| Freebird: Activate Pro License | — | Enter your Pro license key |

### Chat Commands

| Command | Description |
|---|---|
| `/commit` | Generate a commit message |
| `/push` | Push to remote |
| `/status` | Show git status |
| `/memory` | Show project memory (Pro) |
| `/forget` | Clear project memory (Pro) |
| `/clear` | Clear conversation history |
| `/help` | Show all commands |

---

## How the Agent Works (Pro)

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
| `freebird.backend` | `cloud` | AI backend: `cloud`, `ollama`, `anthropic`, `openai`, `deepseek`, `qwen` |
| `freebird.apiKey` | *(empty)* | API key for BYOK backends |
| `freebird.model` | *(auto)* | Override the default model |
| `freebird.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `freebird.licenseKey` | *(empty)* | Pro license key |
| `freebird.telemetry.enabled` | `true` | Anonymous usage analytics (no code/PII) |

---

## Privacy

- **Gemini Flash (free tier):** messages processed by Google's API. No code stored by Freebird.
- **Ollama:** all processing is local — no data leaves your machine. This applies to Agent mode too (Pro) — set the backend to Ollama and multi-file edits, terminal commands, and checkpoints all run without a single cloud call, which is what makes Freebird usable under a corporate no-cloud-AI policy or an NDA that forbids sending code off-machine.
- **Anthropic / OpenAI / DeepSeek / Qwen:** code sent to their APIs under your own account.
- **Freebird AI** (Ten Labs Pty. Limited) never collects or stores your code or conversation data.
- **Web fetches (`fetch_url`):** private/internal addresses (localhost, LAN ranges, cloud metadata endpoints) are blocked, and fetched page content is explicitly marked as untrusted before it reaches the model.
- **Checkpoint restores** can't write outside your workspace folder, even if a checkpoint record were somehow corrupted.

---

## Support

**[support@ten-labs.com.au](mailto:support@ten-labs.com.au)** — payments, license activation, or anything else.

---

## Contributing

Open source (MIT). Issues and PRs welcome at the [GitHub repository](https://github.com/Adilaw12/freebird-vscode).

---

## License

MIT — Copyright © 2025 Ten Labs Pty. Limited
