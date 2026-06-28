# Changelog

## \[0.7.1] — 2026-06-28

### Changed

* **Pro is now the primary CTA on the power-user quota wall** — engaged users who hit the
daily limit are led with "Upgrade to Pro — $6/month" instead of a free 30-day trial. The
trial is demoted to a quiet inline link, and the wall now emphasizes Pro value (unlimited
edits, BYOK, project memory) rather than free escape hatches.

## \[0.7.0] — 2026-06-28

### Added

* **Machine ID in telemetry** — telemetry now reports a stable per-machine ID, and the
backend tracks `_unique_machines` per day for accurate unique-user analytics (relaunches no
longer inflate the count).

### Fixed

* **Quota reset bypass** — the daily free-edit quota was keyed on a per-launch session ID, so
quitting and reopening VS Code reset the quota. Quota is now keyed on a stable machine ID
that persists across restarts, closing the bypass. Users who need more than the daily free
edits are pointed to Pro ($6/mo).

## \[0.6.13] — 2026-06-26

### Fixed

* **Broken README images** — restored correct file paths for the two "See It in Action"
screenshots. Updated version badge to match current release.

## \[0.6.12] — 2026-06-26

### Changed

* **README rewrite for SEO & traffic** — competitive comparison table (vs Copilot, Cursor),
keyword-rich subtitle and meta line, new "What Freebird Replaces" section, updated free tier
from 5 → 20 edits/day throughout, tighter copy and formatting across all sections. Removed
the model customization section to reduce noise.

## \[0.6.11] — 2026-06-26

### Added

* **Suggested prompts on welcome screen** — four clickable prompt buttons (explain file,
find bugs, refactor, write tests) to help new users get started immediately.
* **Usage stats bar** — shows edits used today, remaining quota, and sessions on the
welcome screen. Remaining count highlights amber when 3 or fewer edits are left.

## \[0.6.10] — 2026-06-25

### Added

* **Personalized quota wall for power users** — users with 15+ edits in a session see a
founder message from Adisa offering a free 30-day Pro trial via email, instead of the
generic upgrade wall. Regular users still see the standard quota wall.
* **Announcement endpoint** — new `/api/announcement` serverless function for dynamic
founder messages. Currently inactive; flip the commented config to broadcast to all users.

## \[0.6.9] — 2026-06-23

### Added

* **Backend health endpoint** — new `/api/health` serverless function pings Gemini with a
minimal request and returns `200 ok`, `502 degraded`, or `503 down`. Wire it up to
UptimeRobot (or any monitor) at `https://freebird-backend.vercel.app/api/health` to get
alerted when the Gemini integration goes down.

## \[0.6.2] — 2026-06-23

### Fixed

* **Critical: api\_error on first message** - users on the default Ollama backend were hitting
connection errors immediately because Ollama auto-install was silently failing on most machines
(blocked by macOS Gatekeeper, Windows UAC, and corporate firewalls). This has been replaced
with a clear, actionable prompt.
* **Upgrade button not reaching Stripe** - pricing mismatch between in-extension messaging
($6 USD) and Stripe checkout (A$9) caused users to abandon at checkout. Stripe is now
correctly set to $6 USD/month.

### Added

* **Gemini Flash as default free tier** - new installs now work immediately with no setup.
Gemini 2.0 Flash powers your 5 free advanced edits/day via the Freebird cloud backend.
No Ollama installation required to get started.
* **Automatic Ollama → Gemini fallback** — if you have Ollama configured but it becomes
unreachable, Freebird now automatically falls back to Gemini Flash instead of showing
an error. A one-time notification explains what happened.
* **Post-quota Gemini fallback** — after your 5 free cloud edits are used, Freebird tries
local Ollama first (if installed), then falls back to Gemini Flash (20 fallback
requests/hr) so you're never completely blocked.
* **Upgrade prompt telemetry** — tracks when users see and interact with the upgrade prompt,
giving better visibility into the conversion funnel.

### Changed

* **Default backend changed from `ollama` to `cloud`** — new installs default to Gemini Flash.
Existing users with a saved backend preference are unaffected.
* **Pricing updated to $6 USD/month** — replaces the previous A$9/month Stripe link.
Existing Pro subscribers are unaffected.
* **Ollama setup flow simplified** — instead of a silent auto-install that failed on most
machines, Freebird now shows a clear prompt with two options: install Ollama manually,
or switch to Gemini Flash cloud edits.
* **`/help` text updated** to reflect Gemini Flash as the free tier provider.

\---

## \[0.6.1] — 2026-06-19

### Added

* **Remote telemetry** — anonymous usage analytics sent to Vercel backend (event counts, no code/PII). Batched every 60 seconds, respects `freebird.telemetry.enabled` setting
* **Analytics dashboard** — password-protected dashboard at `/dashboard` showing sessions, feature popularity, backend/platform/version breakdowns, daily trends, and error tracking
* **Granular event tracking** — per-tool usage (`tool\_used\_read\_file`, `tool\_used\_edit\_file`, etc.), API errors, Ollama connectivity errors, tool execution errors

## \[0.6.0] — 2026-06-19

### Added

* **Download file tool** — agent can download files from URLs and save them to the workspace
* **Create diagram tool** — agent can generate Mermaid diagrams (flowcharts, sequence, ER, Gantt, etc.) and render them in a live preview tab
* **Copy file tool** — agent can copy/paste files within the workspace
* **Thinking animation** — fun rotating status phrases while AI is processing ("Herding electrons...", "Pondering...", "Discombobulating...", etc.)
* **Auto Ollama setup** — on first load, automatically detects, starts, or downloads+installs Ollama without prompting (cancellable progress notification)
* **Upgrade nudges** — contextual, dismissible Pro upgrade prompts for free users: when cloud edits run low, after impressive multi-tool agent runs, and periodically in Ollama fallback mode

### Changed

* **DeepSeek default model** updated from `deepseek-coder-v2` to `deepseek-reasoner` (V4-pro)
* DeepSeek backend label updated to "DeepSeek V4-pro" in the configure picker
* Model override description updated with `deepseek-reasoner` as default

## \[0.4.3] — 2026-06-14

### Added

* **Live HTML preview** — the agent can open a rendered preview tab for any HTML file it creates or edits (`preview\_html`), no Live Server extension required. Preview auto-refreshes on save. Also available via right-click → "Freebird: Preview HTML" on any HTML file.
* **Free trial for the agent** — free users get 5 full codebase-aware agent runs per month (indexing, multi-file edits, inline edit) before falling back to plain chat. Remaining count shown via `/help` and after each trial run.

### Improved

* `edit\_file` now falls back to a whitespace-insensitive line match when an exact `oldStr` match isn't found, making edits more reliable
* When building a website, the agent now writes every file the HTML references (CSS, JS, etc.) instead of leaving dangling `<link>`/`<script>` references

### Changed

* README refresh: marketplace badges, clearer "affordable open-source Copilot alternative" positioning, optimized keyword list for search discovery, and new SVG hero banner + feature-highlight graphics (`media/banner.svg`, `media/feature-grid.svg`)

## \[0.4.2] — 2026-06-13

### Improved

* Agent now outlines a short plan (numbered steps) before tackling multi-step or multi-file tasks, so you can see what it's about to do — similar to Cursor Composer

### Changed

* Extension icon recolored to a monochrome grey/black-and-white palette for a more professional look
* Removed decorative emoji from README section headers

## \[0.4.1] — 2026-06-13

### Docs

* Note in the `freebird.model` setting and README recommending `claude-sonnet-4-6` for heavier multi-file agent tasks (Pro)

## \[0.4.0] — 2026-06-13

### Added

* **Project memory (Pro)** — Freebird can save notes (conventions, decisions, in-progress work) to `.freebird/memory.md`, which is automatically loaded into context on future requests. New `/memory` and `/forget` chat commands to view or clear it.

### Improved

* Agent now prefers actually creating files (`write\_file`) when asked to "make", "build", "create", or "scaffold" something, instead of just printing example code in chat

## \[0.3.1] — 2026-06-13

### Added

* Support contact (`support@ten-labs.com.au`) — shown in `/help`, the Stripe success/error pages, and the README

### Fixed

* License validation regex now matches the `FB-XXXX-XXXX-XXXX-XXXX` key format (previously still checked for the old `OP-` prefix, causing valid Pro keys to be rejected)

## \[0.3.0] — 2026-06-12

### Added

* **Tab autocomplete** — free inline ghost-text code completions, powered by Ollama, Claude, or OpenAI
* **Ollama onboarding** — on first run, prompts to install Ollama or pick a different AI backend if it isn't running

### Fixed

* Agent tool-calling loop (`executeToolCall` was missing) — codebase read/write/search/run-command/git actions now work, with approval gating and path-traversal protection
* Removed duplicate extension name shown in the chat webview header

### Security

* Backend: restrict CORS to known origins, validate license key format, strengthen Stripe webhook handling

## \[0.2.1] — 2026-06-12

### Changed

* **Renamed to Freebird AI** — new name, same product, zero conflicts
* All commands, settings, and extension IDs updated to `freebird.\*`
* License key format updated to `FB-XXXX-XXXX-XXXX-XXXX`

\---

## \[0.2.0] — 2026-06-12

### Added

* **@ file mentions** — type `@filename` in chat to inject any file as context
* **`/` command picker** — type `/` to see all slash commands with descriptions
* **Clear conversation** button + `/clear` command
* **`/help`** command listing all available commands and shortcuts
* **History trimming** — conversation capped to prevent context overflow
* **Pro gating** — Pro features now properly require an active license

### Improved

* **Chat UI redesign** — custom SVG logo, feature grid welcome screen, full markdown renderer
* **Markdown rendering** — headings, lists, blockquotes, code copy buttons
* **Performance** — workspace file tree cached per session (no re-scan on every message)
* **Performance** — license status cached in memory (no network call on every message)
* **Performance** — both caches pre-warmed at startup so first message is instant
* **Inline edit** — now sends surrounding context so the AI understands scope

### Fixed

* Pro features could be triggered without a valid license
* Offline grace period now only applies to previously server-confirmed keys

\---

## \[0.1.3] — 2026-06-09

### Added

* Initial marketplace release
* Standalone chat panel — no GitHub Copilot required
* Agentic codebase tools: read, search, write, edit files
* Multi-step agent loop with approve/reject flow
* Inline code editing with `Ctrl+Alt+K`
* AI commit message generation
* Git push and status support
* Ollama, Anthropic Claude, and OpenAI backends

