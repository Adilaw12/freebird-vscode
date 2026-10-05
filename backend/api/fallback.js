// api/fallback.js  —  Freebird Ollama-failure fallback endpoint
// Called only when Ollama is unreachable. This is the safety net that ensures
// users always get a response.
//
// Quota: enforces the SAME daily caps as /api/chat (per-machine + per-IP) and
// shares the same Redis keys, so fallback can't be used to bypass the chat
// quota. Also keeps a short-term hourly IP burst limit for abuse protection.

import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import { verifySession } from '../lib/authToken.js';
import { isLicenseActive, hasTemplateLibraryAccess, FREE_TEMPLATE_IDS } from '../lib/license.js';
import { TEMPLATE_CATALOG } from '../lib/templateCatalog.js';
import { templateHaikuDailyLimit } from '../lib/templateWelcome.js';
import { fetchGeminiWithFallback, PRO_GEMINI_MODEL_CANDIDATES } from '../lib/geminiModel.js';
import { fetchAnthropicWithFallback, anthropicConfigured } from '../lib/anthropicModel.js';
import { fetchCerebrasWithFallback, cerebrasConfigured } from '../lib/cerebrasModel.js';
import { quotaKeysFor, reserveQuota, refundQuota, reserveSingleCounter } from '../lib/quota.js';
import { createLineSplitter } from '../lib/sseLines.js';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Daily quota — shared with /api/chat via identical Redis keys
const DAILY_LIMIT    = 10;  // chat/edits, per machine/session per day (cut from 20 on 2026-09-14)
const IP_DAILY_LIMIT = 200; // per IP per day — higher so shared networks aren't blocked
const QUOTA_TTL      = 24 * 60 * 60; // 1 day in seconds

// Tab completions: separate bucket, same numbers as chat.js — see that file.
const COMPLETION_DAILY_LIMIT    = 100;
const COMPLETION_IP_DAILY_LIMIT = 1000;
const COMPLETION_MAX_TOKENS     = 256;
const COMPLETION_GLOBAL_DAILY_LIMIT = parseInt(process.env.COMPLETION_GLOBAL_DAILY_LIMIT || '0', 10);

// See chat.js — same rollout flag, same meaning.
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

// Cost circuit breaker + monitoring — shared with /api/chat (same keys)
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || '0', 10); // 0/unset = off
const MONITOR_TTL        = 8 * 24 * 60 * 60;
const hashIp = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 16);

// Short-term abuse protection: 20 fallback calls per IP per hour. Completions
// get their own, larger burst counter — they fire on typing pauses, so 20/hour
// would cap them far below their daily allowance.
const IP_RATE_LIMIT  = 20;
const COMPLETION_IP_RATE_LIMIT = 200;
const IP_RATE_TTL    = 60 * 60; // 1 hour

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Server misconfigured', code: 'NO_API_KEY' });
    }

    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon').trim();
    const { messages, maxTokens: requestedMaxTokens = 2048, sessionId: rawSession, authToken, licenseKey, templateId, templateLicenseKey, isTabCompletion } = req.body ?? {};
    const isCompletion = isTabCompletion === true;

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
    }

    // ── Pro/Enterprise: fully unmetered — skips the IP burst limit too ─────────
    let unmetered = false;
    if (licenseKey && typeof licenseKey === 'string') {
        try {
            const license = await redis.get(`license:${licenseKey.trim().toUpperCase()}`);
            if (isLicenseActive(license)) {
                unmetered = true;
            }
        } catch (err) {
            console.error('License lookup error (fallback):', err);
        }
    }

    // ── IP burst rate limit ─────────────────────────────────────────────────
    if (!unmetered) {
        const ipKey = isCompletion ? `fallback:cmp:ip:${ip}` : `fallback:ip:${ip}`;
        try {
            const { blocked } = await reserveSingleCounter(redis, ipKey, isCompletion ? COMPLETION_IP_RATE_LIMIT : IP_RATE_LIMIT, IP_RATE_TTL);
            if (blocked) {
                return res.status(429).json({
                    error: 'Too many fallback requests. Please try again later or upgrade to Pro.',
                    code:  'IP_RATE_LIMITED'
                });
            }
        } catch { /* non-blocking — don't fail the request on Redis errors */ }
    }

    // ── Identity: GitHub-verified session preferred over legacy machine id ─────
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

    // ── Daily quota (same two layers as /api/chat, shared Redis keys) ──────────
    // Without this, fallback could be used to bypass the /api/chat daily quota.
    // Atomic reserve-then-refund — see backend/lib/quota.js for the full
    // race-condition rationale.
    const today = new Date().toISOString().slice(0, 10);

    // ── Free-template Haiku eligibility — see chat.js for the full rationale ──
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
                console.error('Template license lookup error (fallback):', err);
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

    const quotaKeys = quotaKeysFor(identityKey, ip, today, isCompletion ? 'completion' : 'chat');
    const dailyLimit = isCompletion ? COMPLETION_DAILY_LIMIT : DAILY_LIMIT;
    const ipDailyLimit = isCompletion ? COMPLETION_IP_DAILY_LIMIT : IP_DAILY_LIMIT;
    let sessionUsed = 0, ipUsed = 0;

    if (!unmetered) {
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
            // Distinct code for completions — see chat.js.
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
        : requestedMaxTokens;

    // ── Build provider request(s) ────────────────────────────────────────────
    // Same Haiku-for-unmetered / Gemini-for-everyone-else split as chat.js —
    // see that file for the full rationale. Both bodies are built
    // unconditionally so Gemini is ready as an immediate fallback.
    const systemParts       = [];
    const geminiContents    = [];
    const anthropicMessages = [];
    const cerebrasMessages  = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemParts.push(msg.content);
        } else {
            geminiContents.push({
                role:  msg.role === 'assistant' ? 'model' : 'user',
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
            temperature:     0.2,
        },
        ...(systemParts.length > 0 && {
            systemInstruction: { parts: systemParts.map(text => ({ text })) }
        })
    };

    const anthropicBody = {
        max_tokens:  maxTokens,
        temperature: 0.2,
        stream:      true,
        messages:    anthropicMessages,
        // Same caching rationale as chat.js — see that file for the full note.
        ...(systemParts.length > 0 && {
            system: [{ type: 'text', text: systemParts.join('\n\n'), cache_control: { type: 'ephemeral' } }]
        })
    };

    // OpenAI-compatible shape — see chat.js for the full rationale, including
    // why reasoning_effort: 'low' is required (not optional) for this model.
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

    // ── Stream response ──────────────────────────────────────────────────────
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
                    console.error('Anthropic fallback error, falling back to Gemini:', result.response.status, await result.response.text().catch(() => ''));
                }
            } catch (err) {
                console.error('Anthropic request failed, falling back to Gemini:', err);
            }
        }

        // Free-tier tab completions only — see chat.js for the full rationale
        // (including why an 8s timeout, not the usual 30s).
        if (!upstream && !unmetered && isTabCompletion && cerebrasConfigured()) {
            try {
                const result = await fetchCerebrasWithFallback(cerebrasBody, { signal: AbortSignal.timeout(8_000) });
                if (result.response.ok) {
                    upstream = result.response;
                    modelUsed = result.modelUsed;
                    provider = 'cerebras';
                } else {
                    console.error('Cerebras fallback error, falling back to Gemini:', result.response.status, await result.response.text().catch(() => ''));
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
            console.error(`${provider} fallback error:`, upstream.status, errText);
            if (!unmetered) await refundQuota(redis, quotaKeys); // never charge for a failed upstream request
            return res.status(502).json({
                error:  'AI provider error',
                code:   'UPSTREAM_ERROR',
                status: upstream.status
            });
        }

        // Quota was already reserved atomically before this request began (see
        // above) — no increment needed here. Just track unique-IP monitoring.
        if (!unmetered) {
            await redis.sadd(`monitor:ips:${today}`, hashIp(ip)).catch(() => {});
            await redis.expire(`monitor:ips:${today}`, MONITOR_TTL).catch(() => {});
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('X-Fallback-Active', 'true'); // extension can detect this
        res.setHeader('X-Model-Used', modelUsed); // helps spot a fallback engaging in the wild
        if (templateBonusUsed) {
            res.setHeader('X-Template-Bonus-Used', 'true');
        }

        if (unmetered) {
            res.setHeader('X-Quota-Unmetered', 'true');
        } else {
            // sessionUsed/ipUsed are already POST-increment (this request included)
            const remaining = Math.max(0, Math.min(
                dailyLimit - sessionUsed,
                ipDailyLimit - ipUsed
            ));
            res.setHeader(isCompletion ? 'X-Completion-Quota-Remaining' : 'X-Quota-Remaining', String(remaining));
        }

        const reader  = upstream.body.getReader();
        const splitter = createLineSplitter();

        const handleLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === '[DONE]') return;
            try {
                const parsed = JSON.parse(jsonStr);
                // Cerebras: OpenAI-compatible choices[0].delta.content — see chat.js
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

        res.end();
    } catch (err) {
        console.error('Fallback handler error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
        } else {
            res.end();
        }
    }
}
