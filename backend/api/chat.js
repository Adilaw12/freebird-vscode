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

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.0-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

const DAILY_LIMIT = 20; // was 5
const QUOTA_TTL      = 24 * 60 * 60; // 1 day in seconds

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

    const { messages, sessionId, maxTokens = 2048 } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId required', code: 'BAD_REQUEST' });
    }

    // ── Quota check ──────────────────────────────────────────────────────────
    const today       = new Date().toISOString().slice(0, 10);
    const quotaKey    = `quota:${sessionId.slice(0, 48)}:${today}`;

    const current = await redis.get(quotaKey).catch(() => null);
    const used    = parseInt(current ?? '0', 10);

    if (used >= DAILY_LIMIT) {
        return res.status(429).json({
            error: 'Daily cloud edit limit reached (5/day free). Upgrade to Pro for unlimited.',
            code:  'QUOTA_EXCEEDED',
            used,
            limit: DAILY_LIMIT
        });
    }

    // Increment quota (set with TTL on first use)
    const pipeline = redis.pipeline();
    pipeline.incr(quotaKey);
    if (used === 0) pipeline.expire(quotaKey, QUOTA_TTL);
    await pipeline.exec().catch(() => {}); // non-blocking — don't fail the request

    // ── Build Gemini request ─────────────────────────────────────────────────
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

        // Stream as plain text — extension reads line by line
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('X-Quota-Used',      String(used + 1));
        res.setHeader('X-Quota-Remaining', String(Math.max(0, DAILY_LIMIT - used - 1)));

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
