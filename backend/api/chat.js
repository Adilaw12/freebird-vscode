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

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

const DAILY_LIMIT    = 20;  // per machine/session per day
const IP_DAILY_LIMIT = 200; // per IP per day — higher so shared networks (offices, VPNs) aren't blocked
const QUOTA_TTL      = 24 * 60 * 60; // 1 day in seconds

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

    const { messages, sessionId: rawSession, maxTokens = 2048 } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
    }

    // sessionId is optional — older extension versions don't send it
    // Fall back to IP-based tracking so they still get quota enforcement
    const sessionId = (rawSession && typeof rawSession === 'string')
        ? rawSession
        : ((req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon').trim();

    // ── Quota check (two layers: machine/session + IP) ────────────────────────
    // Machine ID alone was bypassable, so we also cap per IP per day. A request
    // is blocked if EITHER the session/machine quota or the IP quota is exhausted.
    const today = new Date().toISOString().slice(0, 10);
    const ip    = ((req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon').trim();

    const sessionQuotaKey = `quota:${sessionId.slice(0, 48)}:${today}`;
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

    // Cost circuit breaker (off unless GLOBAL_DAILY_LIMIT is set)
    if (GLOBAL_DAILY_LIMIT > 0 && globalUsed >= GLOBAL_DAILY_LIMIT) {
        return res.status(503).json({
            error: 'Free tier is temporarily at capacity. Please try again later or upgrade to Pro.',
            code:  'GLOBAL_CAPACITY'
        });
    }

    // Block if EITHER layer is exhausted — the per-machine cap or the higher IP cap
    if (sessionUsed >= DAILY_LIMIT || ipUsed >= IP_DAILY_LIMIT) {
        return res.status(429).json({
            error: 'Daily cloud edit limit reached. Upgrade to Pro for unlimited access.',
            code:  'QUOTA_EXCEEDED',
            limit: DAILY_LIMIT
        });
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
        const upstream = await fetch(GEMINI_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(geminiBody),
            signal:  AbortSignal.timeout(30_000)
        });

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => upstream.statusText);
            console.error('Gemini error:', upstream.status, errText);
            return res.status(502).json({
                error: 'AI provider error',
                code:  'UPSTREAM_ERROR',
                status: upstream.status
            });
        }

        // ── Increment quota only after confirmed successful response ──────────
        // Users are never charged for failed Gemini requests. Increment BOTH the
        // session/machine counter and the IP counter so neither layer can be
        // bypassed (resetting the machine ID still hits the IP cap, and vice versa).
        const pipeline = redis.pipeline();
        pipeline.incr(sessionQuotaKey);
        if (sessionUsed === 0) pipeline.expire(sessionQuotaKey, QUOTA_TTL);
        pipeline.incr(ipQuotaKey);
        if (ipUsed === 0) pipeline.expire(ipQuotaKey, QUOTA_TTL);
        // Monitoring: global daily call count + unique IPs (hashed for privacy)
        pipeline.incr(globalKey);
        if (globalUsed === 0) pipeline.expire(globalKey, MONITOR_TTL);
        pipeline.sadd(`monitor:ips:${today}`, hashIp(ip));
        pipeline.expire(`monitor:ips:${today}`, MONITOR_TTL);
        await pipeline.exec().catch(() => {});

        // Stream as plain text — extension reads line by line
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        // Remaining reflects whichever layer binds first (machine vs IP)
        const remaining = Math.max(0, Math.min(
            DAILY_LIMIT - sessionUsed - 1,
            IP_DAILY_LIMIT - ipUsed - 1
        ));
        res.setHeader('X-Quota-Used',      String(sessionUsed + 1));
        res.setHeader('X-Quota-Remaining', String(remaining));

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
