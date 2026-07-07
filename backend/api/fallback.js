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

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.0-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

// Daily quota — shared with /api/chat via identical Redis keys
const DAILY_LIMIT    = 20;  // per machine/session per day
const IP_DAILY_LIMIT = 200; // per IP per day — higher so shared networks aren't blocked
const QUOTA_TTL      = 24 * 60 * 60; // 1 day in seconds

// See chat.js — same rollout flag, same meaning.
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

// Cost circuit breaker + monitoring — shared with /api/chat (same keys)
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || '0', 10); // 0/unset = off
const MONITOR_TTL        = 8 * 24 * 60 * 60;
const hashIp = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 16);

// Short-term abuse protection: 20 fallback calls per IP per hour
const IP_RATE_LIMIT  = 20;
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
    const { messages, maxTokens = 2048, sessionId: rawSession, authToken, licenseKey } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
    }

    // ── Pro/Enterprise: fully unmetered — skips the IP burst limit too ─────────
    let unmetered = false;
    if (licenseKey && typeof licenseKey === 'string') {
        try {
            const license = await redis.get(`license:${licenseKey.trim().toUpperCase()}`);
            if (license && license.status === 'active' && ['pro', 'enterprise', 'team'].includes(license.plan)) {
                unmetered = true;
            }
        } catch (err) {
            console.error('License lookup error (fallback):', err);
        }
    }

    // ── IP burst rate limit ─────────────────────────────────────────────────
    if (!unmetered) {
        const ipKey = `fallback:ip:${ip}`;
        try {
            const current = await redis.get(ipKey).catch(() => null);
            const count   = parseInt(current ?? '0', 10);

            if (count >= IP_RATE_LIMIT) {
                return res.status(429).json({
                    error: 'Too many fallback requests. Please try again later or upgrade to Pro.',
                    code:  'IP_RATE_LIMITED'
                });
            }

            const pipeline = redis.pipeline();
            pipeline.incr(ipKey);
            if (count === 0) pipeline.expire(ipKey, IP_RATE_TTL);
            await pipeline.exec().catch(() => {});
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
    const today = new Date().toISOString().slice(0, 10);

    const sessionQuotaKey = `quota:${identityKey.slice(0, 48)}:${today}`;
    const ipQuotaKey      = `quota:ip:${ip}:${today}`;
    const globalKey       = `quota:global:${today}`;

    const [sessionCount, ipCount, globalCount] = await Promise.all([
        redis.get(sessionQuotaKey).catch(() => null),
        redis.get(ipQuotaKey).catch(() => null),
        redis.get(globalKey).catch(() => null)
    ]);
    const sessionUsed = parseInt(sessionCount ?? '0', 10);
    const ipUsed      = parseInt(ipCount ?? '0', 10);
    const globalUsed  = parseInt(globalCount ?? '0', 10);

    if (!unmetered) {
        // Cost circuit breaker (off unless GLOBAL_DAILY_LIMIT is set)
        if (GLOBAL_DAILY_LIMIT > 0 && globalUsed >= GLOBAL_DAILY_LIMIT) {
            return res.status(503).json({
                error: 'Free tier is temporarily at capacity. Please try again later or upgrade to Pro.',
                code:  'GLOBAL_CAPACITY'
            });
        }

        if (sessionUsed >= DAILY_LIMIT || ipUsed >= IP_DAILY_LIMIT) {
            return res.status(429).json({
                error: 'Daily cloud edit limit reached. Upgrade to Pro for unlimited access.',
                code:  'QUOTA_EXCEEDED',
                limit: DAILY_LIMIT
            });
        }
    }

    // ── Build Gemini request ─────────────────────────────────────────────────
    const systemParts    = [];
    const geminiContents = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemParts.push({ text: msg.content });
        } else {
            geminiContents.push({
                role:  msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: msg.content }]
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
            systemInstruction: { parts: systemParts }
        })
    };

    // ── Stream response ──────────────────────────────────────────────────────
    try {
        const upstream = await fetch(GEMINI_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(geminiBody),
            signal:  AbortSignal.timeout(30_000)
        });

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => upstream.statusText);
            console.error('Gemini fallback error:', upstream.status, errText);
            return res.status(502).json({
                error:  'AI provider error',
                code:   'UPSTREAM_ERROR',
                status: upstream.status
            });
        }

        // ── Increment both daily counters after a confirmed success ───────────
        // Shared with /api/chat so neither endpoint can bypass the other's quota.
        // Skipped entirely for unmetered (Pro/Enterprise) requests.
        if (!unmetered) {
            const quotaPipeline = redis.pipeline();
            quotaPipeline.incr(sessionQuotaKey);
            if (sessionUsed === 0) quotaPipeline.expire(sessionQuotaKey, QUOTA_TTL);
            quotaPipeline.incr(ipQuotaKey);
            if (ipUsed === 0) quotaPipeline.expire(ipQuotaKey, QUOTA_TTL);
            // Monitoring: global daily call count + unique IPs (hashed for privacy)
            quotaPipeline.incr(globalKey);
            if (globalUsed === 0) quotaPipeline.expire(globalKey, MONITOR_TTL);
            quotaPipeline.sadd(`monitor:ips:${today}`, hashIp(ip));
            quotaPipeline.expire(`monitor:ips:${today}`, MONITOR_TTL);
            await quotaPipeline.exec().catch(() => {});
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('X-Fallback-Active', 'true'); // extension can detect this

        if (unmetered) {
            res.setHeader('X-Quota-Unmetered', 'true');
        } else {
            const remaining = Math.max(0, Math.min(
                DAILY_LIMIT - sessionUsed - 1,
                IP_DAILY_LIMIT - ipUsed - 1
            ));
            res.setHeader('X-Quota-Remaining', String(remaining));
        }

        const reader  = upstream.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const raw = decoder.decode(value);
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
        console.error('Fallback handler error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal error', code: 'SERVER_ERROR' });
        } else {
            res.end();
        }
    }
}
