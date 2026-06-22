// api/fallback.js  —  Freebird Ollama-failure fallback endpoint
// Called only when Ollama is unreachable. No per-user quota — this is the
// safety net that ensures users always get a response. Rate-limited by IP
// to prevent abuse (20 requests/hour per IP).
//
// Distinct from /api/chat which enforces the 5 free-edit quota.

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = 'gemini-2.0-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

// Abuse protection: 20 fallback calls per IP per hour
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

    // ── IP rate limit ────────────────────────────────────────────────────────
    const ip = (
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.socket?.remoteAddress ||
        'unknown'
    ).trim();

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

    const { messages, maxTokens = 2048 } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required', code: 'BAD_REQUEST' });
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

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('X-Fallback-Active', 'true'); // extension can detect this

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
