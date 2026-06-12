# OpenPilot — Free AI Coding Assistant

> ⚠️ **This extension has been renamed to Freebird AI.** Development continues under the new name — please install [Freebird AI](https://marketplace.visualstudio.com/items?itemName=TenLabs.freebird-ai) for future updates. This page is kept for existing users; the content below reflects the last release under the OpenPilot AI name.

> A fully open-source, Copilot-free AI assistant for VS Code. Reads your entire codebase, edits files, runs commands, and pushes to GitHub — powered by Ollama, Claude, or OpenAI.

---

## Features

### 🧠 Understands Your Whole Codebase
OpenPilot automatically indexes your workspace file tree and can read any file on demand. Ask it to refactor a module, trace a bug across files, or add a feature — it will read the relevant files first, then make targeted edits.

### ✏️ Makes Real Code Changes
The AI can create and edit files directly in your workspace. Every write, edit, or destructive action shows an **Approve / Reject** card before anything is touched — you stay in full control.

### 🔀 Git Integration
Generate commit messages, push to remote, and check status — all from the chat panel.

### ⚡ Inline Edit (Cursor-style)
Select any code, press `Ctrl+Alt+K`, type an instruction, and the selection is rewritten in place.

### 🆓 Completely Free — No Copilot Required
Works with **Ollama** (local, totally free), **Anthropic Claude** (pay-as-you-go, very cheap), or **OpenAI**. No GitHub Copilot subscription needed.

---

## Getting Started

### Option 1 — Ollama (free, runs locally)

1. Install [Ollama](https://ollama.ai)
2. Pull a coding model:
   ```
   ollama pull qwen2.5-coder
   ```
3. Open OpenPilot chat (`Ctrl+Alt+O`) — it works immediately, no API key needed.

### Option 2 — Anthropic Claude

1. Get an API key at [console.anthropic.com](https://console.anthropic.com)
2. Run **OpenPilot: Configure AI Backend** from the Command Palette
3. Select **Anthropic Claude** and paste your API key.

### Option 3 — OpenAI

1. Get an API key at [platform.openai.com](https://platform.openai.com)
2. Run **OpenPilot: Configure AI Backend** from the Command Palette
3. Select **OpenAI** and paste your API key.

---

## Commands

| Command | Shortcut | Description |
|---|---|---|
| OpenPilot: Open Chat | `Ctrl+Alt+O` | Open the AI chat panel |
| OpenPilot: Edit with AI | `Ctrl+Alt+K` | Rewrite selected code with AI |
| OpenPilot: AI Commit | — | Open chat and generate a commit message |
| OpenPilot: Configure AI Backend | — | Switch between Ollama / Claude / OpenAI |

### Chat Slash Commands

| Command | Description |
|---|---|
| `/commit` | Analyze staged/unstaged changes and propose a commit message |
| `/push` | Push current branch to remote |
| `/status` | Show git status |

---

## What the AI Can Do

When you ask OpenPilot to perform a task, it runs an **agent loop** — similar to Cursor's Composer or GitHub Copilot Edits:

1. **Reads** your workspace file tree automatically
2. **Fetches** specific files it needs to understand the code
3. **Searches** the codebase for symbols, patterns, or text
4. **Edits** files with targeted diffs (shows before/after for approval)
5. **Creates** new files (shows preview for approval)
6. **Runs** terminal commands (shows command for approval)
7. **Commits and pushes** changes (requires approval)

All write operations require your explicit approval — nothing is modified silently.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `openpilot.backend` | `ollama` | AI backend: `ollama`, `anthropic`, or `openai` |
| `openpilot.apiKey` | *(empty)* | API key for Anthropic or OpenAI |
| `openpilot.model` | *(auto)* | Override the default model for the selected backend |
| `openpilot.ollamaUrl` | `http://localhost:11434` | Ollama server URL |

**Default models per backend:**
- Ollama: `qwen2.5-coder`
- Anthropic: `claude-haiku-4-5-20251001`
- OpenAI: `gpt-4o-mini`

---

## Privacy

- **Ollama**: all processing happens locally on your machine — no data leaves your computer.
- **Anthropic / OpenAI**: your code is sent to their APIs under your account. Review their privacy policies before use.
- OpenPilot itself (developed by Ten Labs Pty. Limited) never collects or transmits any data.

---

## Contributing

OpenPilot is open source. Issues and pull requests are welcome at the [GitHub repository](https://github.com/your-username/openpilot-vscode).

---

## License

MIT — Copyright (c) 2025 Ten Labs Pty. Limited. See [LICENSE](LICENSE) for details.
