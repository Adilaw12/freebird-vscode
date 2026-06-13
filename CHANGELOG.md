# Changelog

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
