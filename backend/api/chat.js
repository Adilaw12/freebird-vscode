// api/chat.js  —  Freebird free-tier cloud AI endpoint
// Proxies to Gemini 2.0 Flash. Called by CloudProvider in the VS Code extension.
//
// Request:  POST /api/chat
//   { messages: [{role, content}], sessionId: string, maxTokens?: number }
//
// Response: streaming text/plain (one chunk per line)
//   or { error, code } on failure
//
// Quota is enforced server-side using Redis (same db as telemetry).
// 20 free edits per sessionId per UTC day.
// Quota is only incremented on successful responses — failed requests are never charged.

import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';
import { verifySession } from '../lib/authToken.js';
import { isLicenseActive } from '../lib/license.js';
import { fetchGeminiWithFallback } from '../lib/geminiModel.js';
import { quotaKeysFor, reserveQuota, refundQuota } from '../lib/quota.js';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const DAILY_LIMIT    = 20;  // per machine/session per day
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

    const { messages, sessionId: rawSession, authToken, licenseKey, maxTokens = 2048 } = req.body ?? {};

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

    // ── Build Gemini request ─────────────────────────────────────────────────
    // NOTE: quota is only incremented AFTER a successful Gemini response
    // so users are never charged for failed requests
    // Gemini uses 'user'/'model' roles; split out system prompt if present
    const systemParts = [];
    const geminiContents = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemParts.push({ text: msg.content });
        } else {
            geminiContents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
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
            systemInstruction: { parts: systemParts }
        })
    };

    // ── Stream Gemini response back to extension ─────────────────────────────
    try {
        const { response: upstream, modelUsed } = await fetchGeminiWithFallback(
            'streamGenerateContent',
            geminiBody,
            { signal: AbortSignal.timeout(30_000) }
        );

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => upstream.statusText);
            console.error('Gemini error:', upstream.status, errText);
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
                    const text   = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
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
