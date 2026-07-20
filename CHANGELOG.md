# Changelog

## \[0.8.7] — 2026-07-20

### Added

* **Copy conversation to clipboard** — a new icon button in the chat panel's top bar copies
the current conversation (prompts, responses, and a short note per tool call) to the
clipboard as Markdown, for sharing with a teammate or pasting into a bug report. No new
redaction logic was needed: the chat webview already only ever receives the clean, already-
redacted view (the user's raw typed text, the model's prose, and tool output already
truncated to 200 chars server-side) — full file contents and injected context never reach
the webview in the first place. Resets along with `/clear` so a cleared conversation can
never leak into a later export.
* **The "Configure AI Backend" picker no longer lets an unlicensed user configure a BYOK
backend that would silently do nothing.** Previously you could pick Anthropic/OpenAI/
DeepSeek/Qwen, enter an API key, and see a "configured!" confirmation even with no active
license — `getProvider()` would then silently fall back to the free cloud tier the moment
you actually tried to use it, with no indication anything had gone differently than
expected. The picker now checks license status upfront: unlicensed BYOK entries show as
`Requires Pro` and selecting one goes straight to the upgrade prompt, instead of a config
flow that quietly wouldn't have worked.

### Fixed

* **Telemetry events could be silently lost on normal VS Code shutdown**, including
security-relevant events like `byok_blocked_no_license` — found while investigating a user
report and being unable to conclusively confirm from telemetry alone whether the BYOK gate
had actually fired for them. Root cause: the final flush on deactivation was fire-and-forget
two levels deep (`disposeTelemetry()` didn't return/await `flush()`'s promise, and
`deactivate()` didn't await `disposeTelemetry()` either), even though VS Code's extension
host does await a Thenable returned from `deactivate()` — that existing mechanism just
wasn't wired up. Now properly awaited end to end. Doesn't help on a hard crash/force-kill
(deactivate never runs at all in that case) — durable crash-resilient telemetry would need
persisting the pending queue, which is a bigger change than this fix; not doing that now.

## \[0.8.6] — 2026-07-15

### Added

* **Per-turn checkpoints for the Pro agent.** Every Pro chat turn that creates, edits, copies,
or downloads a file now gets a "Checkpoint saved" card with a Restore button, letting you
revert every file that turn touched back to its state before the turn — the agent already
lets the AI write/edit/run commands across a workspace with only a single approve/reject
gate per tool call, and until now there was no way to undo a turn afterward beyond your own
git history. Only the four tools that directly mutate file content are covered; a turn that
also ran a shell command or `git push` is explicitly labeled "can't be undone by restore"
rather than silently pretending to cover it. Checkpoint data lives in per-workspace extension
storage (not your repo), capped at the last 20 turns.
* **`fetch_url` agent tool** — the agent can now read a webpage's content directly (docs,
articles, a URL you paste in) instead of only being able to search your own codebase.
Returns extracted plain text (HTML/scripts/styles stripped), not raw markup.

### Security

* **`fetch_url` blocks requests to private/internal addresses** (localhost, LAN ranges, and
the `169.254.169.254` cloud-metadata endpoint that's a classic SSRF target), checked at the
same DNS resolution Node uses to actually open the connection — not a separate upfront
lookup, which would leave a window for a DNS-rebinding bypass. Literal IP hosts (e.g. a URL
that's already `http://169.254.169.254/...` with no hostname to resolve) are checked
directly for the same reason: Node never calls a custom DNS resolver when there's nothing to
resolve, so that path needed its own explicit guard — found via testing against the real
network, not just unit tests, after the initial version relied solely on the DNS hook.

## \[0.8.5] — 2026-07-11

### Fixed

* **`api_error` telemetry fired unconditionally, before checking whether the failure was
actually expected.** A quota-exceeded response (429 — someone hit their daily cap, working
exactly as intended), an auth-required response, and a rate-limit response all got counted
as generic "errors" alongside genuine unexpected failures, on top of each already being
tracked under its own specific event. This made completely normal daily quota hits look like
production errors in the dashboard, even when Vercel's own logs showed nothing but expected
429s. Now `api_error` only fires for the actual catch-all/unexpected case; `IP_RATE_LIMITED`
gets its own `rate_limited` event instead of silently falling into the generic bucket.
* **`byok_blocked_no_license` telemetry was a raw fire-count, not a meaningful daily signal** —
tab completion re-triggers the BYOK gate on every keystroke pause, so one person typing
continuously with an unlicensed BYOK backend configured could rack up dozens of these events
in a single sitting. Now deduped to once per identity per day (same pattern as the other
`_unique_*` metrics), so the number actually reflects "how many people hit this today," not
"how many keystrokes triggered it."
* **Dashboard's "Unique Machines" KPI was silently wrong** — it summed each day's `_unique_machines`
count across the selected window, which double/triple/N-counts anyone active on more than one
day (a machine active daily for 14 days contributed 14, not 1). Now computed as a true
deduplicated count via `SUNION` across the per-day `telemetry:machines:{date}` sets — the
number now actually means what the label says. Falls back to the old (now-labeled) sum
estimate if the union query fails for any reason, rather than showing nothing.

## \[Unreleased]

### Added

* **Country tracking** — `telemetry:countries:{date}` hash, sourced from Vercel's own
edge-set `x-vercel-ip-country` header (not client-reported, can't be spoofed the way a
client-supplied field could). Same mechanism the (since-reverted) PPP pricing feature used,
here purely observational — no pricing impact. Dashboard now shows a distinct-country count
and per-country session breakdown for the selected window, useful both for understanding
where usage is coming from and as evidence of genuine international reach.
* **Dashboard: "Days Since Last Paid Conversion" KPI and a "Growth Toward 10,000" section** —
scans the loaded window for the most recent `pro_subscribed` event, and computes a
week-over-week active-machine trend (via the same `SUNION` dedup approach as the Unique
Machines fix) with a linear projection toward 10,000 unique machines. Deliberately labeled
as a rough estimate in the UI itself, not just explained once elsewhere — compares weekly
*active* machines (a returning user counts in both windows, so it's not a pure new-installs
rate) and assumes the current trend holds linearly, which growth rarely does around a launch
spike. Requires a 14d+ window to compute; shows a clear "not enough history yet" message
otherwise rather than a misleading number.

### Critical fix

* **Free-tier quota could overshoot its cap under concurrent requests — the actual cause of
users reporting a quota reading of 21 instead of capping at 20.** The old logic read the
current count, made the (multi-second, for a streaming chat response) AI provider call, and
only incremented *after* success. That left a race window spanning the entire round-trip:
two nearly-simultaneous requests from the same identity (a double-click, two chat panels
open, a client retry) could both read the same stale count, both pass the `< 20` check, both
succeed, and both increment — overshooting the cap. Worse, this was trivially exploitable:
firing many requests in parallel while under the limit could let all of them slip past the
check before any single increment landed, getting far more than 20 for free with no
technical sophistication required.
* Fixed by extracting the quota logic into **`backend/lib/quota.js`** (previously
near-duplicated between `chat.js` and `fallback.js`) using an **atomic reserve-then-refund**
pattern: increment first (before any slow work), check the result, and refund the
reservation if it's over the limit or if the AI provider call itself fails. `INCR` is atomic
per-key even inside a non-atomic Redis pipeline, so reserving before the slow work closes
the race window entirely — no request can be counted twice, and no request is ever charged
for quota it didn't actually get served for.
* 7 new tests (`test/quota-race.test.js`) that actually fire 30 concurrent requests at the
real quota logic against a mock Redis client with realistic artificial latency (without
that latency, a single-threaded test would never interleave concurrent calls and would pass
regardless of whether the underlying code was actually race-free) — verifies exactly 20 of
30 succeed, the rest are blocked, the final stored count is exactly 20 (not 21+), and that
both blocked and failed-upstream requests are correctly refunded rather than leaking quota.

## \[0.8.4] — 2026-07-10

### Critical fix

* **Free-tier chat and fallback were down (502s) — Gemini deprecated the models we were using.**
`gemini-2.5-flash` (chat.js, health.js) and `gemini-2.0-flash` (fallback.js) both stopped
working — Google's own changelog confirms `gemini-2.0-flash` was shut down June 1, 2026, and
production logs showed `gemini-2.5-flash` returning 404 "no longer available" as of July 9,
2026, ahead of whatever official date is eventually published. Also caught before it ever
shipped: the semantic search embedding proxy (built earlier this session, not yet deployed)
was built against `text-embedding-004`, also already shut down per Google's changelog —
switched to `gemini-embedding-001` before this ever went live.

### Added — safety net against this recurring

* **`backend/lib/geminiModel.js`**: a single source of truth for which Gemini model(s) to
use, with an automatic fallback chain (`gemini-3.1-flash-lite` → `gemini-2.5-flash-lite` →
`gemini-2.5-flash`). `chat.js` and `fallback.js` now go through this instead of a hardcoded
model string each — a single model's deprecation no longer takes the whole tier down; a
404 on one candidate automatically tries the next before failing the request. Only retries
on 404 (model gone) — a 429 (rate limit) or 5xx isn't retried across models, since switching
models won't fix those. Responses include an `X-Model-Used` header so a fallback engaging
in production is visible, not silent.
* **`health.js` rewritten to check every candidate in the chain, not just the primary** —
returns `degraded` (502, non-2xx) the moment the *primary* model fails even while a fallback
is quietly covering for it, so the existing "alert on non-2xx" UptimeRobot config catches a
model going down immediately, not only once the entire fallback chain is exhausted. Also
reports `backupsRemaining` so you can see the safety margin shrinking before it hits zero.
* 4 new tests (`test/gemini-fallback.test.js`) covering: primary success (no fallback
triggered), primary 404 → correctly advances to the next candidate, primary 429 → correctly
does NOT retry across models, and full exhaustion when every candidate fails.
* **Lesson for next time:** hardcoded model IDs are a production liability with Gemini's
current deprecation cadence (multiple forced migrations within months of each other per
Google's own release notes) — worth periodically checking `ai.google.dev/gemini-api/docs/deprecations`
even with this safety net in place, since the chain only has 3 candidates before it's
genuinely out of runway.

### Added

* **Codebase semantic search** — new `search_codebase_semantic` agent tool alongside the
existing regex-based `search_code`, so the agent can find conceptually related code even
when the query words don't literally appear (e.g. "where do we handle auth expiry" finds
the right file even if it never says "expiry"). Architecture, deliberately kept cheap:
  - **No hosted vector database.** Embeddings are stored locally per-workspace
  (`.freebird/codeindex.json`) and searched via brute-force cosine similarity — completely
  fine at single-repo scale, and means code never leaves the user's machine except for the
  one API call needed to compute each embedding.
  - **Three embedding backends, mirroring the existing chat backend routing**: Ollama
  (`nomic-embed-text`, local, always free), cloud (Gemini `gemini-embedding-001`, proxied
  through the same `GEMINI_API_KEY` chat already uses — no new env var), and OpenAI BYOK
  (gated behind an active license, same rule as `getProvider()`'s BYOK gate).
  - **Incremental, not a full rebuild every time**: a content-hash check skips re-embedding
  unchanged files; a file-save watcher keeps the index current automatically once one
  exists. Indexing is opt-in by use (first `search_codebase_semantic` call, or
  `Freebird: Build Codebase Index`) — not a cost every workspace pays on activation whether
  or not the agent is ever used.
  - New `backend/api/embed.js`: much more generous daily limits than chat (embeddings cost
  roughly two orders of magnitude less per token, and indexing is a one-time-per-file cost,
  not per-message) — still unmetered for an active Pro/Team/Enterprise/trial license.
* 9 new tests (`test/chunker.test.js`, `test/vector-math.test.js`, `test/index-store.test.js`)
covering chunking edge cases, cosine similarity math, and the store's persistence/dedup
behavior — all pure logic, no vscode mock needed for these three.

## \[0.8.3] — 2026-07-09

### Security

* **Fixed: BYOK backends had zero license check — any free user could bypass the entire
paywall via a settings dropdown.** `getProvider()` returned `AnthropicProvider`/
`OpenAIProvider`/`DeepSeekProvider`/`QwenProvider` directly with no check that the user
held an active Pro/Team/Enterprise license, despite the README stating "All BYOK models
require Pro." This affected all four call sites that route through `getProvider`: inline
edit, tab completion, `/commit`, and the Pro chat path — meaning a free user could set
`Freebird: Backend` to `openai`, supply their own API key, and get fully unmetered,
unlimited use with no subscription, no quota, and no spoofing required. Fixed by gating
BYOK backends behind a synchronous cached license check (`getCachedLicenseStatus`) at the
single `getProvider()` choke point; unlicensed users now transparently fall back to the
free cloud tier with a one-time explanatory notification instead of silently getting BYOK
for free. This was surfaced by telemetry showing users on the `openai` backend without a
way to confirm they were actually licensed.
* Dashboard: removed `ollama_fallback` from the error classification — it's a normal
quota-exhaustion routing event, not a failure, and was making the error count look
alarming for what's actually a sign of real usage. Added `byok_blocked_no_license` to
Feature Popularity so the fix above is measurable going forward.

### Added

* **First committed test suite** (`test/`, run via `npm test`) — this repo had zero
automated tests until now, which is exactly how both the BYOK gap above and the
12-day chat-panel outage (see v0.8.0 below) shipped and went unnoticed. Covers:
  - A permanent regression guard on `media/chat.html`'s inline script actually parsing
  (the exact bug class that broke chat for 12 days — a syntax error anywhere in that
  one `<script>` tag silently kills every handler in it)
  - The BYOK license gate, against 5 scenarios (unlicensed, rejected license, active
  Pro, active trial, and a sanity check that Ollama was never wrongly gated)
  - License status parsing across every plan type (pro/team/enterprise/trial) plus
  fail-closed behavior on server errors
  Tests run against the actual compiled output in `out/`, not a re-implementation of
  the logic, using a minimal committed `vscode` mock (`test/mocks/vscode.js`) — not a
  full test framework, since the suite is still small enough not to need one yet.

## \[0.8.2] — 2026-07-09

### Added

* **Self-serve 7-day Pro trial** — replaces the old "email the founder" trial
request with a one-click "start a 7-day free trial" link in the quota wall.
Gated on GitHub sign-in (same identity used for free-tier quota) so a trial
can only be claimed once per GitHub account; no manual key copy/paste — it
activates immediately. Trial licenses are fully unmetered (like Pro) until
they expire, then automatically stop working with no cron job needed.
Tracked in the conversion funnel as a new `trial_started` stage between
"quota wall shown" and "subscribed".

## \[0.8.0] — 2026-07-07

### Critical fix

* **Chat panel has been completely non-functional since v0.6.10** — two unescaped
apostrophes inside single-quoted JS strings (`You're a serious Freebird user`, `You're
clearly getting real value from Freebird`, both in the quota-wall messaging) broke the
entire inline `<script>` block's parse, silently killing every event handler in the chat
webview. Nothing renders, nothing throws a visible error, sending a message just does
nothing. This has been live since v0.6.10 and shipped in every version through v0.7.4.
Inline edit (a separate code path) was unaffected. Fixed by escaping both apostrophes;
verified the whole script block now parses cleanly.

### Security

* **GitHub sign-in replaces spoofable machine ID for free-tier identity** — the previous
identity (`vscode.env.machineId`, self-reported in the request body) could be reset or
spoofed by resetting/reinstalling, defeating the per-machine daily quota even with the
0.7.3 per-IP layer in place. Free cloud edits are now tracked against a GitHub account,
verified server-side against GitHub's own API (`/api/auth-github`) and bound to a signed
session token the client can't forge. The per-IP layer remains as a second check. Rollout
is gradual: `REQUIRE_AUTH` stays off until most installs are updated, then flips on to
fully close the legacy path.
* **Fixed: Pro subscribers were still hitting the free-tier daily quota** — `/api/chat` and
`/api/fallback` never actually checked license status server-side, so Pro users on the
default cloud backend were capped at 20/day same as free users. Both endpoints now accept
a `licenseKey` and skip all quota checks entirely for an active Pro or Enterprise license.

### Added

* **Enterprise plan** — a new self-serve Stripe plan, detected automatically from the
purchased Price ID via the webhook and tagged as `plan: 'enterprise'`. Functionally
identical to Pro (fully unmetered) — the difference is price and support tier.
* **Team plan** — flat $25/month for up to 5 seats, aimed at small dev teams. One
subscription = one team; the owner allocates seats from inside the extension
(`Freebird: Manage Team Seats` — list/add/remove) via the new `/api/team-seats`
endpoint, no separate dashboard. Cancelling the owner's subscription cancels all
seats. Seats are fully unmetered, same as Pro/Enterprise.
* **First-run walkthrough** — new installs now see a guided walkthrough (backend choice →
GitHub sign-in → first edit → command reference → optional upgrade) instead of landing on
an empty chat panel with no orientation.
* Status bar and chat header now show **Team** / **Enterprise** vs **Pro** distinctly, and
reflect a signed-in GitHub account when on the free tier.

## \[0.7.4] — 2026-06-28

### Changed

* **README** — added a GitHub star call-to-action to help with discovery.

## \[0.7.3] — 2026-06-28

### Fixed

* **Second quota-bypass layer (per-IP)** — the daily quota now enforces two layers: the
per-machine cap (20/day) and a higher per-IP cap (200/day). Resetting the machine ID still
counts against the IP, closing the bypass. The IP limit is set high (200) so shared networks
(offices, VPNs, university campuses) aren't blocked.
* **Fallback endpoint no longer bypasses quota** — `/api/fallback` previously had no daily
quota, so it could be used to sidestep `/api/chat`. It now enforces the same per-machine and
per-IP daily caps, sharing the same Redis keys. As a result, cloud fallback (when Ollama is
unreachable) now counts toward the daily free-edit quota.

## \[0.7.2] — 2026-06-28

### Added

* **Conversion funnel telemetry** — tracks the full path from `quota_wall_shown` →
`upgrade_clicked` → `pro_subscribed` (recorded server-side from the Stripe webhook). The
analytics dashboard now shows a Conversion Funnel section with wall→click→paid rates, plus
unique-machine and new-subscription KPIs, so conversion can be diagnosed with data.

### Security

* **Resolved all dependency vulnerabilities** — upgraded the `@vscode/vsce` build tool
(2.32.0 → 3.9.2) and patched its transitive deps (`undici`, `form-data`, `markdown-it`).
These were dev/build-time only and never shipped to users; `npm audit` is now clean.

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

