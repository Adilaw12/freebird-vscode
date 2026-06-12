# Changelog

## [0.2.0]

### Added
- `@file` mentions in chat — reference workspace files by name to inject their content into context
- Workspace file list sent to the chat UI for `@` autocomplete
- Workspace file-tree caching with file-watcher invalidation for faster agent responses

### Changed
- "AI Commit" and "Inline Edit" are now Pro features, with in-editor prompts to upgrade or activate a license
- Faster license checks via an in-memory cache layer, with a stricter offline grace period (only for keys previously validated as Pro)
- Rebranded UI strings from "OpenPilot" to "OpenPilot AI"

## [0.1.0] — 2025

### Added
- Standalone chat panel — no GitHub Copilot required
- Agentic codebase tools: read files, search code, write and edit files
- Multi-step agent loop: AI reads your codebase then makes targeted edits
- Approval flow for all write/edit/run/push operations
- Inline code editing with `Ctrl+Alt+K`
- AI commit message generation (`/commit`)
- Git push support (`/push`, `/status`)
- Supports Ollama (free/local), Anthropic Claude, and OpenAI backends
