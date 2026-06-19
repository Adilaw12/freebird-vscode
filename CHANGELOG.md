# Changelog

## [0.6.0] — 2026-06-19

### Added
- **Download file tool** — agent can download files from URLs and save them to the workspace
- **Create diagram tool** — agent can generate Mermaid diagrams (flowcharts, sequence, ER, Gantt, etc.) and render them in a live preview tab
- **Copy file tool** — agent can copy/paste files within the workspace
- **Thinking animation** — fun rotating status phrases while AI is processing ("Herding electrons...", "Pondering...", "Discombobulating...", etc.)
- **Auto Ollama setup** — on first load, automatically detects, starts, or downloads+installs Ollama without prompting (cancellable progress notification)
- **Upgrade nudges** — contextual, dismissible Pro upgrade prompts for free users: when cloud edits run low, after impressive multi-tool agent runs, and periodically in Ollama fallback mode

### Changed
- **DeepSeek default model** updated from `deepseek-coder-v2` to `deepseek-reasoner` (V4-pro)
- DeepSeek backend label updated to "DeepSeek V4-pro" in the configure picker
- Model override description updated with `deepseek-reasoner` as default

## [0.4.3] — 2026-06-14

### Added
- **Live HTML preview** — the agent can open a rendered preview tab for any HTML file it creates or edits (`preview_html`), no Live Server extension required. Preview auto-refreshes on save. Also available via right-click → "Freebird: Preview HTML" on any HTML file.
- **Free trial for the agent** — free users get 5 full codebase-aware agent runs per month (indexing, multi-file edits, inline edit) before falling back to plain chat. Remaining count shown via `/help` and after each trial run.

### Improved
- `edit_file` now falls back to a whitespace-insensitive line match when an exact `oldStr` match isn't found, making edits more reliable
- When building a website, the agent now writes every file the HTML references (CSS, JS, etc.) instead of leaving dangling `<link>`/`<script>` references

### Changed
- README refresh: marketplace badges, clearer "affordable open-source Copilot alternative" positioning, optimized keyword list for search discovery, and new SVG hero banner + feature-highlight graphics (`media/banner.svg`, `media/feature-grid.svg`)

## [0.4.2] — 2026-06-13

### Improved
- Agent now outlines a short plan (numbered steps) before tackling multi-step or multi-file tasks, so you can see what it's about to do — similar to Cursor Composer

### Changed
- Extension icon recolored to a monochrome grey/black-and-white palette for a more professional look
- Removed decorative emoji from README section headers

## [0.4.1] — 2026-06-13

### Docs
- Note in the `freebird.model` setting and README recommending `claude-sonnet-4-6` for heavier multi-file agent tasks (Pro)

## [0.4.0] — 2026-06-13

### Added
- **Project memory (Pro)** — Freebird can save notes (conventions, decisions, in-progress work) to `.freebird/memory.md`, which is automatically loaded into context on future requests. New `/memory` and `/forget` chat commands to view or clear it.

### Improved
- Agent now prefers actually creating files (`write_file`) when asked to "make", "build", "create", or "scaffold" something, instead of just printing example code in chat

## [0.3.1] — 2026-06-13

### Added
- Support contact (`support@ten-labs.com.au`) — shown in `/help`, the Stripe success/error pages, and the README

### Fixed
- License validation regex now matches the `FB-XXXX-XXXX-XXXX-XXXX` key format (previously still checked for the old `OP-` prefix, causing valid Pro keys to be rejected)

## [0.3.0] — 2026-06-12

### Added
- **Tab autocomplete** — free inline ghost-text code completions, powered by Ollama, Claude, or OpenAI
- **Ollama onboarding** — on first run, prompts to install Ollama or pick a different AI backend if it isn't running

### Fixed
- Agent tool-calling loop (`executeToolCall` was missing) — codebase read/write/search/run-command/git actions now work, with approval gating and path-traversal protection
- Removed duplicate extension name shown in the chat webview header

### Security
- Backend: restrict CORS to known origins, validate license key format, strengthen Stripe webhook handling

## [0.2.1] — 2026-06-12

### Changed
- **Renamed to Freebird AI** — new name, same product, zero conflicts
- All commands, settings, and extension IDs updated to `freebird.*`
- License key format updated to `FB-XXXX-XXXX-XXXX-XXXX`

---

## [0.2.0] — 2026-06-12

### Added
- **@ file mentions** — type `@filename` in chat to inject any file as context
- **`/` command picker** — type `/` to see all slash commands with descriptions
- **Clear conversation** button + `/clear` command
- **`/help`** command listing all available commands and shortcuts
- **History trimming** — conversation capped to prevent context overflow
- **Pro gating** — Pro features now properly require an active license

### Improved
- **Chat UI redesign** — custom SVG logo, feature grid welcome screen, full markdown renderer
- **Markdown rendering** — headings, lists, blockquotes, code copy buttons
- **Performance** — workspace file tree cached per session (no re-scan on every message)
- **Performance** — license status cached in memory (no network call on every message)
- **Performance** — both caches pre-warmed at startup so first message is instant
- **Inline edit** — now sends surrounding context so the AI understands scope

### Fixed
- Pro features could be triggered without a valid license
- Offline grace period now only applies to previously server-confirmed keys

---

## [0.1.3] — 2026-06-09

### Added
- Initial marketplace release
- Standalone chat panel — no GitHub Copilot required
- Agentic codebase tools: read, search, write, edit files
- Multi-step agent loop with approve/reject flow
- Inline code editing with `Ctrl+Alt+K`
- AI commit message generation
- Git push and status support
- Ollama, Anthropic Claude, and OpenAI backends
