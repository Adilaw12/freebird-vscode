// api/chat.js  —  Freebird cloud AI endpoint
// Free tier proxies to Gemini (see geminiModel.js); Pro/Enterprise/trial
// (unmetered) traffic proxies to Claude Haiku 4.5 (see anthropicModel.js),
// falling back to Gemini if Anthropic is unreachable. Called by CloudProvider
// in the VS Code extension.
//
// Request:  POST /api/chat
//   { messages: [{role, content}], sessionId: string, maxTokens?: number }
//
// Response: streaming text/plain (one chunk per line)
//   or { error, code } on failure
//
// Quota is enforced server-side using Redis (same db as telemetry).
// 10 free edits per sessionId per UTC day (cut from 20 on 2026-09-14 — see
// README/CHANGELOG for the announcement and rationale).
// Quota is only incremented on successful responses — failed requests are never charged.

import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import { verifySession } from '../lib/authToken.js';
import { isLicenseActive, hasTemplateLibraryAccess, FREE_TEMPLATE_IDS } from '../lib/license.js';
import { TEMPLATE_CATALOG } from '../lib/templateCatalog.js';
import { templateHaikuDailyLimit } from '../lib/templateWelcome.js';
import { fetchGeminiWithFallback, PRO_GEMINI_MODEL_CANDIDATES } from '../lib/geminiModel.js';
import { fetchAnthropicWithFallback, anthropicConfigured, SONNET_MODEL_CANDIDATES } from '../lib/anthropicModel.js';
import { fetchCerebrasWithFallback, cerebrasConfigured } from '../lib/cerebrasModel.js';
import { quotaKeysFor, reserveQuota, refundQuota, reserveSingleCounter } from '../lib/quota.js';
import { textOnlyContent } from '../lib/messageContent.js';
import { createLineSplitter } from '../lib/sseLines.js';
import { reserveAgentTrial, refundAgentTrial, AGENT_TRIAL_MAX_TOKENS } from '../lib/agentTrial.js';
import { createUsageTracker, usageAudience, modelFamily, recordUsage } from '../lib/usageStats.js';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DAILY_LIMIT    = 10;  // chat/edits, per machine/session per day
const IP_DAILY_LIMIT = 200; // per IP per day — higher so shared networks (offices, VPNs) aren't blocked
const QUOTA_TTL      = 24 * 60 * 60; // 1 day in seconds

// Tab completions have their own, much larger bucket (see lib/quota.js).
// 100/day ≈ 3,000/month — above Copilot Free's completion allowance. Served
// on Cerebras at ~$0.0007 each, so even every daily-active free user maxing
// out stays around $4/day.
const COMPLETION_DAILY_LIMIT    = 100;
const COMPLETION_IP_DAILY_LIMIT = 1000;
// isTabCompletion is client-supplied, so a modified client could label a chat
// message as a "completion" to use the larger bucket. Capping output length
// for that bucket makes it useless for real chat (completions request 128).
const COMPLETION_MAX_TOKENS     = 256;

// Once REQUIRE_AUTH=true is set in Vercel, unauthenticated requests (no valid
// GitHub session token) are rejected outright instead of falling back to the
// old, spoofable machine-id/IP scheme. Leave unset/false during rollout so
// installs still on older extension versions keep working, then flip it on
// once telemetry shows most active users are on a version that signs in.
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

// Cost circuit breaker: max free cloud calls across ALL users per day.
// OFF by default (0/unset) — costs are tiny until very high volume. Set the
// GLOBAL_DAILY_LIMIT env var in Vercel to activate once daily volume is large
// enough that runaway abuse could matter (~10k+/day).
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || '0', 10);
const COMPLETION_GLOBAL_DAILY_LIMIT = parseInt(process.env.COMPLETION_GLOBAL_DAILY_LIMIT || '0', 10);

// Premium Agent-mode requests on Claude Sonnet 5, metered per licence per
// calendar month (UTC). Counted per model request, not per task: one Agent-mode
// task is typically 4-5 requests, and at ~$0.04/request (Sonnet 5, $2/$10 per
// MTok, cached system prompt) 100 requests is a worst case of ~$4 of the $10
// Pro price. Trials get a smaller taste. Past the limit, requests silently use
// the normal Haiku path — never blocked.
const PREMIUM_MONTHLY_LIMITS = { pro: 100, team: 100, enterprise: 100, trial: 25 };
const PREMIUM_TTL = 35 * 24 * 60 * 60;
// Sonnet 5 thinks by default and thinking tokens count against max_tokens, so
// the agent loop's default 2048 would truncate real output.
const SONNET_MIN_MAX_TOKENS = 8192;
const MONITOR_TTL        = 8 * 24 * 60 * 60; // keep daily monitoring keys ~8 days

const hashIp = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 16);

export const config = { runtime: 'nodejs' }; // streaming needs Node runtime, not edge

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server misconfigured', code: 'NO_API_KEY' });
    }

    const { messages, sessionId: rawSession, authToken, licenseKey, templateId, templateLicenseKey, maxTokens: requestedMaxTokens = 2048, isTabCompletion, premium, agentTrial } = req.body ?? {};
    const isCompletion = isTabCompletion === true;

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const ip    = ((req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon').trim();

    // ── Pro/Enterprise: fully unmetered, no quota checks at all ────────────────
    // Checked first and independently of identity — a valid active license on
    // either plan skips every limit below.
    let unmetered = false;
    let licensePlan = null;
    const normalizedLicenseKey = (licenseKey && typeof licenseKey === 'string') ? licenseKey.trim().toUpperCase() : null;
    if (normalizedLicenseKey) {
        try {
            const license = await redis.get(`license:${normalizedLicenseKey}`);
            if (isLicenseActive(license)) {
                unmetered = true;
                licensePlan = license.plan;
            }
        } catch (err) {
            console.error('License lookup error (chat):', err);
            // fail closed — treat as unlicensed rather than blocking the request
        }
    }

    // ── Premium (Sonnet) allowance ─────────────────────────────────────────────
    // Only the Agent-mode loop sends premium:true. Spoofing it can only spend
    // the caller's own monthly allowance, so it isn't a security boundary.
    const premiumLimit = PREMIUM_MONTHLY_LIMITS[licensePlan] ?? 0;
    const premiumKey = normalizedLicenseKey ? `premium:${normalizedLicenseKey}:${new Date().toISOString().slice(0, 7)}` : null;
    let premiumReserved = false;
    let premiumRemaining = null;
    if (unmetered && premium === true && isTabCompletion !== true && premiumLimit > 0 && anthropicConfigured()) {
        try {
            const { count, blocked } = await reserveSingleCounter(redis, premiumKey, premiumLimit, PREMIUM_TTL);
            premiumReserved = !blocked;
            premiumRemaining = blocked ? 0 : Math.max(0, premiumLimit - count);
        } catch (err) {
            console.error('Premium allowance error (chat):', err); // fall through to Haiku
        }
    }

    // ── Identity: GitHub-verified session preferred over legacy machine id ─────
    // A session token can only exist if api/auth-github.js independently
    // verified a real GitHub access token, so it can't be spoofed by sending an
    // arbitrary string the way the old plain sessionId could.
    const session = (!unmetered && authToken) ? verifySession(authToken) : null;

    if (!unmetered && !session && REQUIRE_AUTH) {
        return res.status(401).json({
            error: 'Sign in with GitHub to use Freebird\'s free cloud tier.',
            code:  'AUTH_REQUIRED'
        });
    }

    const identityKey = session
        ? `gh:${session.sub}`
        : ((rawSession && typeof rawSession === 'string') ? rawSession : ip);

    // ── Free-template Haiku eligibility ─────────────────────────────────────
    // The 3 free built-in templates hallucinate noticeably more on Gemini
    // Flash Lite than on Haiku, and they're exactly the showcase content the
    // paid Template Library pitch leans on — so a template-seeded message
    // (identified by templateId, never trusted for anything beyond routing)
    // gets a quality bump: unlimited for a valid Template Library subscriber,
    // else one free bonus run per identity per day, else the existing
    // Gemini-for-free-tier behavior, never blocked either way.
    let templateHaikuEligible = false;
    let templateBonusUsed = false;
    // How many free Haiku template runs/day this request qualifies for: 1 for the
    // 3 free templates, 2 for any template while the device is inside its 7-day
    // welcome window (lib/templateWelcome.js), 0 otherwise.
    const templateBonusLimit = (!unmetered && templateId && anthropicConfigured())
        ? await templateHaikuDailyLimit(redis, {
            templateId,
            machineId: rawSession,
            freeIds: FREE_TEMPLATE_IDS,
            allIds: TEMPLATE_CATALOG.map(t => t.id).concat(FREE_TEMPLATE_IDS)
        })
        : 0;
    if (templateBonusLimit > 0) {
        let hasTemplateAccess = false;
        if (templateLicenseKey && typeof templateLicenseKey === 'string') {
            try {
                const tLicense = await redis.get(`license:${templateLicenseKey.trim().toUpperCase()}`);
                hasTemplateAccess = hasTemplateLibraryAccess(tLicense);
            } catch (err) {
                console.error('Template license lookup error (chat):', err);
            }
        }
        if (hasTemplateAccess) {
            templateHaikuEligible = true; // $3/mo subscriber — unlimited
        } else {
            const bonusKey = `template-haiku:${identityKey}:${today}`;
            const { blocked } = await reserveSingleCounter(redis, bonusKey, templateBonusLimit, QUOTA_TTL);
            if (!blocked) {
                templateHaikuEligible = true;
                templateBonusUsed = true;
            }
        }
    }

    // ── Free Agent-mode trial reservation ───────────────────────────────────
    // Spoofing agentTrial:true only buys the capped Haiku budget below, which
    // is the same thing the feature gives away on purpose.
    let agentTrialReserved = false;
    let agentTrialRemaining = null;
    let agentTrialKeys = null;
    if (!unmetered && agentTrial === true && !isCompletion) {
        if (!anthropicConfigured()) {
            return res.status(503).json({ error: 'Agent trial is temporarily unavailable.', code: 'AGENT_TRIAL_UNAVAILABLE' });
        }
        const trial = await reserveAgentTrial(redis, identityKey, hashIp(ip), today);
        if (trial.blocked) {
            return res.status(429).json(trial.code === 'AGENT_TRIAL_EXHAUSTED'
                ? { error: 'Free Agent-mode runs used up. Try Pro free for 7 days, or upgrade.', code: trial.code }
                : { error: 'Too many free Agent-mode requests from this network today. Try again tomorrow.', code: trial.code });
        }
        agentTrialReserved = true;
        agentTrialRemaining = trial.remaining;
        agentTrialKeys = trial.keys;
    }

    // ── Quota (two layers: identity + IP) ───────────────────────────────────
    // ATOMIC reserve-then-refund, not check-then-increment — see
    // backend/lib/quota.js for the full race-condition rationale (this is
    // exactly how users ended up with a quota reading of 21 instead of
    // capping at 20).
    const quotaKeys = quotaKeysFor(identityKey, ip, today, isCompletion ? 'completion' : 'chat');
    const dailyLimit = isCompletion ? COMPLETION_DAILY_LIMIT : DAILY_LIMIT;
    const ipDailyLimit = isCompletion ? COMPLETION_IP_DAILY_LIMIT : IP_DAILY_LIMIT;
    let sessionUsed = 0, ipUsed = 0;

    if (!unmetered && !agentTrialReserved) {
        const result = await reserveQuota(redis, quotaKeys, {
            dailyLimit,
            ipDailyLimit,
            globalDailyLimit: isCompletion ? COMPLETION_GLOBAL_DAILY_LIMIT : GLOBAL_DAILY_LIMIT,
            quotaTtl: QUOTA_TTL,
            monitorTtl: MONITOR_TTL
        });
        sessionUsed = result.sessionUsed;
        ipUsed = result.ipUsed;

        if (result.blocked && result.blockReason === 'GLOBAL_CAPACITY') {
            return res.status(503).json({
                error: 'Free tier is temporarily at capacity. Please try again later or upgrade to Pro.',
                code:  'GLOBAL_CAPACITY'
            });
        }
        if (result.blocked) {
            // Distinct code for completions: clients treat QUOTA_EXCEEDED as
            // "chat quota is 0" and gate chat features on it (extension.ts),
            // which would wrongly lock chat once completions run out.
            return res.status(429).json(isCompletion
                ? {
                    error: 'Daily tab-completion limit reached. Upgrade to Pro for unlimited access.',
                    code:  'COMPLETION_QUOTA_EXCEEDED',
                    limit: COMPLETION_DAILY_LIMIT
                }
                : {
                    error: 'Daily cloud edit limit reached. Upgrade to Pro for unlimited access.',
                    code:  'QUOTA_EXCEEDED',
                    limit: DAILY_LIMIT
                });
        }
    }

    const maxTokens = (isCompletion && !unmetered)
        ? Math.min(Number(requestedMaxTokens) || COMPLETION_MAX_TOKENS, COMPLETION_MAX_TOKENS)
        : agentTrialReserved
        ? Math.min(Number(requestedMaxTokens) || AGENT_TRIAL_MAX_TOKENS, AGENT_TRIAL_MAX_TOKENS)
        : requestedMaxTokens;

    // ── Build provider request(s) ────────────────────────────────────────────
    // NOTE: quota is only incremented AFTER a successful response so users
    // are never charged for failed requests.
    //
    // Pro/Enterprise/trial (unmetered) traffic is routed to Claude Haiku 4.5 —
    // cheaper and higher quality for coding than Gemini 3.6 Flash. Free tier
    // stays on Gemini. Both request bodies are built unconditionally (cheap)
    // so Gemini is ready as an immediate fallback if Anthropic is unreachable
    // or misconfigured — a paying user should never see a hard failure just
    // because one upstream provider is down.
    const systemParts = [];
    const geminiContents = [];
    const anthropicMessages = [];
    const cerebrasMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemParts.push(msg.content);
        } else {
            const textOnly = textOnlyContent(msg.content);

            geminiContents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: textOnly }]
            });
            anthropicMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content // string or content-block array — passed through unchanged
            });
            cerebrasMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: textOnly
            });
        }
    }

    const geminiBody = {
        contents: geminiContents,
        generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.2,
        },
        ...(systemParts.length > 0 && {
            systemInstruction: { parts: systemParts.map(text => ({ text })) }
        })
    };

    const anthropicBody = {
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: true,
        messages: anthropicMessages,
        // Cached as one block: the whole system prompt (workspace tree, project
        // memory, project rules, tool guidelines) is identical across every
        // iteration of an Agent-mode turn and unchanged turn-to-turn within a
        // session — exactly the case prompt caching exists for. Cache writes
        // cost ~25% more than a normal read, but reads within the 5-minute TTL
        // run ~90% cheaper, which is a clear win for anything beyond a single
        // one-shot call. GA on the Anthropic API since Dec 2024 — no beta header
        // needed for standard ephemeral caching.
        ...(systemParts.length > 0 && {
            system: [{ type: 'text', text: systemParts.join('\n\n'), cache_control: { type: 'ephemeral' } }]
        })
    };

    // OpenAI-compatible shape — system prompt is just another message in the
    // array (unlike Anthropic's separate top-level `system` field), placed first.
    //
    // reasoning_effort: 'low' is NOT optional — verified live against the
    // real API that gpt-oss-120b defaults to heavy chain-of-thought,
    // streamed as separate delta.reasoning tokens BEFORE any delta.content.
    // At this feature's tight maxTokens (128), the default reasoning depth
    // can consume the entire budget and return an empty completion with
    // finish_reason:"length" — confirmed happening at 30 tokens in testing,
    // and confirmed AGAIN at production scale on 2026-10-01: 1,314 Cerebras
    // completion calls that day, only 226 tab_completion_shown (~17%
    // shown rate) — the dominant cause isn't cancellation, it's exactly
    // this reasoning-eats-the-budget failure. 'none' is rejected by this
    // model (only low/medium/high accepted); 'low' still reasons some but
    // needs real headroom past the shared 128 completion budget to
    // reliably leave room for actual content afterward — given ONLY to
    // Cerebras here, not to the Gemini fallback or Haiku (neither has this
    // failure mode, no reason to loosen their budgets too).
    const CEREBRAS_COMPLETION_MAX_TOKENS = 320;
    const cerebrasBody = {
        max_tokens: isCompletion ? CEREBRAS_COMPLETION_MAX_TOKENS : maxTokens,
        temperature: 0.2,
        stream: true,
        reasoning_effort: 'low',
        messages: [
            ...(systemParts.length > 0 ? [{ role: 'system', content: systemParts.join('\n\n') }] : []),
            ...cerebrasMessages
        ]
    };

    // ── Stream provider response back to extension ──────────────────────────
    try {
        let upstream, modelUsed, provider;

        if (premiumReserved) {
            // Separate body: Sonnet 5 rejects `temperature`, and effort bounds
            // how much it spends thinking (thinking is on by default).
            const sonnetBody = {
                max_tokens: Math.max(Number(maxTokens) || 0, SONNET_MIN_MAX_TOKENS),
                stream: true,
                output_config: { effort: 'medium' },
                messages: anthropicMessages,
                ...(anthropicBody.system && { system: anthropicBody.system })
            };
            try {
                const result = await fetchAnthropicWithFallback(sonnetBody, { signal: AbortSignal.timeout(90_000) }, SONNET_MODEL_CANDIDATES);
                if (result.response.ok) {
                    upstream = result.response;
                    modelUsed = result.modelUsed;
                    provider = 'anthropic';
                } else {
                    console.error('Sonnet error, falling back to Haiku:', result.response.status, await result.response.text().catch(() => ''));
                }
            } catch (err) {
                console.error('Sonnet request failed, falling back to Haiku:', err);
            }
            if (!upstream) {
                // Don't charge the allowance for a request Sonnet didn't serve.
                await redis.decr(premiumKey).catch(() => {});
                premiumRemaining = premiumRemaining === null ? null : premiumRemaining + 1;
            }
        }

        if (!upstream && (unmetered || templateHaikuEligible || agentTrialReserved) && anthropicConfigured()) {
            try {
                const result = await fetchAnthropicWithFallback(anthropicBody, { signal: AbortSignal.timeout(30_000) });
                if (result.response.ok) {
                    upstream = result.response;
                    modelUsed = result.modelUsed;
                    provider = 'anthropic';
                } else {
                    console.error('Anthropic error, falling back to Gemini:', result.response.status, await result.response.text().catch(() => ''));
                }
            } catch (err) {
                console.error('Anthropic request failed, falling back to Gemini:', err);
            }
        }

        // Free-tier tab completions only — Pro/unmetered already gets Haiku
        // above. 8s timeout (not the usual 30s): Cerebras is fast enough that
        // a slow response already signals trouble (including its own rate
        // limiting), so bailing quickly to Gemini keeps a misbehaving
        // Cerebras request from making a completion feel slower than the
        // pre-Cerebras baseline — defeating the entire point of using it.
        if (!upstream && !unmetered && isTabCompletion && cerebrasConfigured()) {
            try {
                const result = await fetchCerebrasWithFallback(cerebrasBody, { signal: AbortSignal.timeout(8_000) });
                if (result.response.ok) {
                    upstream = result.response;
                    modelUsed = result.modelUsed;
                    provider = 'cerebras';
                } else {
                    console.error('Cerebras error, falling back to Gemini:', result.response.status, await result.response.text().catch(() => ''));
                }
            } catch (err) {
                console.error('Cerebras request failed, falling back to Gemini:', err);
            }
        }

        if (!upstream) {
            const result = await fetchGeminiWithFallback(
                'streamGenerateContent',
                geminiBody,
                { signal: AbortSignal.timeout(30_000) },
                unmetered ? PRO_GEMINI_MODEL_CANDIDATES : undefined
            );
            upstream = result.response;
            modelUsed = result.modelUsed;
            provider = 'gemini';
        }

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => upstream.statusText);
            console.error(`${provider} error:`, upstream.status, errText);
            // never charge for a failed upstream request
            if (agentTrialReserved) await refundAgentTrial(redis, agentTrialKeys);
            else if (!unmetered) await refundQuota(redis, quotaKeys);
            return res.status(502).json({
                error: 'AI provider error',
                code:  'UPSTREAM_ERROR',
                status: upstream.status
            });
        }

        // Quota was already reserved atomically before this request began (see
        // above) — no increment needed here. Just track unique-IP monitoring,
        // which isn't limit-critical so a race on it doesn't matter.
        if (!unmetered && !agentTrialReserved) {
            await redis.sadd(`monitor:ips:${today}`, hashIp(ip)).catch(() => {});
            await redis.expire(`monitor:ips:${today}`, MONITOR_TTL).catch(() => {});
        }

        // Stream as plain text — extension reads line by line
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('X-Model-Used', modelUsed); // helps spot a fallback engaging in the wild
        if (templateBonusUsed) {
            res.setHeader('X-Template-Bonus-Used', 'true'); // tells the extension to show the one-time upsell nudge
        }

        if (unmetered) {
            res.setHeader('X-Quota-Unmetered', 'true');
            if (premiumRemaining !== null) {
                res.setHeader('X-Premium-Remaining', String(premiumRemaining));
                res.setHeader('X-Premium-Limit', String(premiumLimit));
            }
        } else if (agentTrialReserved) {
            // Deliberately NOT the X-Quota-* headers: installed clients write
            // those into the cached chat quota, and this request never touched it.
            res.setHeader('X-Agent-Trial-Requests-Remaining', String(agentTrialRemaining));
        } else {
            // sessionUsed/ipUsed are already POST-increment (this request included)
            const remaining = Math.max(0, Math.min(
                dailyLimit - sessionUsed,
                ipDailyLimit - ipUsed
            ));
            if (isCompletion) {
                // Separate header on purpose — installed clients write
                // X-Quota-Remaining into their cached chat counter.
                res.setHeader('X-Completion-Quota-Remaining', String(remaining));
            } else {
                res.setHeader('X-Quota-Used',      String(sessionUsed));
                res.setHeader('X-Quota-Remaining', String(remaining));
            }
        }

        const reader  = upstream.body.getReader();
        const splitter = createLineSplitter(); // see lib/sseLines.js for why chunks aren't parsed in isolation

        // SSE lines look like: "data: {...}\n\n".
        // Anthropic token usage (incl. prompt-cache reads/writes) rides on the
        // message_start / message_delta events — collected here, recorded below.
        const usageTracker = createUsageTracker();

        const handleLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') return;
            try {
                const parsed = JSON.parse(jsonStr);
                if (provider === 'anthropic') usageTracker.consume(parsed);
                // Gemini: candidates[0].content.parts[0].text
                // Anthropic: content_block_delta events carry delta.text
                // Cerebras: OpenAI-compatible choices[0].delta.content
                const text = provider === 'anthropic'
                    ? (parsed?.type === 'content_block_delta' ? parsed?.delta?.text : undefined)
                    : provider === 'cerebras'
                    ? parsed?.choices?.[0]?.delta?.content
                    : parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) res.write(text);
            } catch { /* skip malformed SSE lines */ }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            splitter.push(value).forEach(handleLine);
        }
        splitter.flush().forEach(handleLine);

        // Awaited before res.end(): on a serverless runtime, work started after
        // the response closes can be frozen mid-flight. recordUsage never throws.
        if (provider === 'anthropic') {
            await recordUsage(redis, today, usageTracker.snapshot(), {
                audience: usageAudience({ agentTrialReserved, unmetered, licensePlan, templateHaikuEligible, premiumReserved }),
                kind:     isCompletion ? 'completion' : 'chat',
                family:   modelFamily(modelUsed)
            });
        }

        res.end();
    } catch (err) {
        console.error('Chat handler error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
        } else {
            res.end();
        }
    }
}
