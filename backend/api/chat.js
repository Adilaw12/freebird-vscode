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
import { fetchGeminiWithFallback, PRO_GEMINI_MODEL_CANDIDATES } from '../lib/geminiModel.js';
import { fetchAnthropicWithFallback, anthropicConfigured } from '../lib/anthropicModel.js';
import { fetchCerebrasWithFallback, cerebrasConfigured } from '../lib/cerebrasModel.js';
import { quotaKeysFor, reserveQuota, refundQuota, reserveSingleCounter } from '../lib/quota.js';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DAILY_LIMIT    = 10;  // per machine/session per day
const IP_DAILY_LIMIT = 200; // per IP per day — higher so shared networks (offices, VPNs) aren't blocked
const QUOTA_TTL      = 24 * 60 * 60; // 1 day in seconds

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

    const { messages, sessionId: rawSession, authToken, licenseKey, templateId, templateLicenseKey, maxTokens = 2048, isTabCompletion } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const ip    = ((req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon').trim();

    // ── Pro/Enterprise: fully unmetered, no quota checks at all ────────────────
    // Checked first and independently of identity — a valid active license on
    // either plan skips every limit below.
    let unmetered = false;
    if (licenseKey && typeof licenseKey === 'string') {
        try {
            const license = await redis.get(`license:${licenseKey.trim().toUpperCase()}`);
            if (isLicenseActive(license)) {
                unmetered = true;
            }
        } catch (err) {
            console.error('License lookup error (chat):', err);
            // fail closed — treat as unlicensed rather than blocking the request
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
    if (!unmetered && templateId && FREE_TEMPLATE_IDS.includes(templateId) && anthropicConfigured()) {
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
            const { blocked } = await reserveSingleCounter(redis, bonusKey, 1, QUOTA_TTL);
            if (!blocked) {
                templateHaikuEligible = true;
                templateBonusUsed = true;
            }
        }
    }

    // ── Quota (two layers: identity + IP) ───────────────────────────────────
    // ATOMIC reserve-then-refund, not check-then-increment — see
    // backend/lib/quota.js for the full race-condition rationale (this is
    // exactly how users ended up with a quota reading of 21 instead of
    // capping at 20).
    const quotaKeys = quotaKeysFor(identityKey, ip, today);
    let sessionUsed = 0, ipUsed = 0;

    if (!unmetered) {
        const result = await reserveQuota(redis, quotaKeys, {
            dailyLimit: DAILY_LIMIT,
            ipDailyLimit: IP_DAILY_LIMIT,
            globalDailyLimit: GLOBAL_DAILY_LIMIT,
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
            return res.status(429).json({
                error: 'Daily cloud edit limit reached. Upgrade to Pro for unlimited access.',
                code:  'QUOTA_EXCEEDED',
                limit: DAILY_LIMIT
            });
        }
    }

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
            geminiContents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
            });
            anthropicMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
            });
            cerebrasMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content
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
    // finish_reason:"length" — confirmed happening at 30 tokens in testing.
    // 'none' is rejected by this model (only low/medium/high accepted);
    // 'low' still reasons some but reliably leaves room for real content.
    const cerebrasBody = {
        max_tokens: maxTokens,
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

        if ((unmetered || templateHaikuEligible) && anthropicConfigured()) {
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
            if (!unmetered) await refundQuota(redis, quotaKeys); // never charge for a failed upstream request
            return res.status(502).json({
                error: 'AI provider error',
                code:  'UPSTREAM_ERROR',
                status: upstream.status
            });
        }

        // Quota was already reserved atomically before this request began (see
        // above) — no increment needed here. Just track unique-IP monitoring,
        // which isn't limit-critical so a race on it doesn't matter.
        if (!unmetered) {
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
        } else {
            // sessionUsed/ipUsed are already POST-increment (this request included)
            const remaining = Math.max(0, Math.min(
                DAILY_LIMIT - sessionUsed,
                IP_DAILY_LIMIT - ipUsed
            ));
            res.setHeader('X-Quota-Used',      String(sessionUsed));
            res.setHeader('X-Quota-Remaining', String(remaining));
        }

        const reader  = upstream.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const raw = decoder.decode(value);
            // SSE lines look like: "data: {...}\n\n"
            for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const jsonStr = trimmed.slice(5).trim();
                if (jsonStr === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(jsonStr);
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
            }
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
