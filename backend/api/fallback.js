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
import { isLicenseActive } from '../lib/license.js';
import { fetchGeminiWithFallback } from '../lib/geminiModel.js';
import { quotaKeysFor, reserveQuota, refundQuota, reserveSingleCounter } from '../lib/quota.js';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
            if (isLicenseActive(license)) {
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
            const { blocked } = await reserveSingleCounter(redis, ipKey, IP_RATE_LIMIT, IP_RATE_TTL);
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
        const { response: upstream, modelUsed } = await fetchGeminiWithFallback(
            'streamGenerateContent',
            geminiBody,
            { signal: AbortSignal.timeout(30_000) }
        );

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => upstream.statusText);
            console.error('Gemini fallback error:', upstream.status, errText);
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

        if (unmetered) {
            res.setHeader('X-Quota-Unmetered', 'true');
        } else {
            // sessionUsed/ipUsed are already POST-increment (this request included)
            const remaining = Math.max(0, Math.min(
                DAILY_LIMIT - sessionUsed,
                IP_DAILY_LIMIT - ipUsed
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
