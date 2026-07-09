// api/embed.js — cloud-tier embedding proxy (Gemini text-embedding-004) for
// codebase semantic search.
//
// Deliberately much more generous limits than /api/chat: embeddings cost
// roughly two orders of magnitude less per token than chat generation, and
// this is a one-time-per-file cost (re-embedding only happens when a file's
// content actually changes), not a per-message cost like chat. An active
// Pro/Team/Enterprise/trial license still gets unlimited, same as chat.

import { Redis } from '@upstash/redis';
import { verifySession } from '../lib/authToken.js';
import { isLicenseActive } from '../lib/license.js';

const redis = Redis.fromEnv();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBED_MODEL = 'text-embedding-004';
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;

// Generous on purpose — see comment above. This bounds abuse (someone using
// this as a free general-purpose embedding API), not normal indexing usage:
// even a large repo re-embeds only a few hundred chunks on first index, then
// only changed files afterward.
const DAILY_CHUNK_LIMIT = 20_000; // chunks per identity per day
const MAX_CHUNKS_PER_REQUEST = 50;
const MAX_CHUNK_CHARS = 4_000;
const QUOTA_TTL = 24 * 60 * 60;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { texts, sessionId: rawSession, authToken, licenseKey } = req.body ?? {};

    if (!Array.isArray(texts) || texts.length === 0) {
        return res.status(400).json({ error: 'texts (non-empty array) required' });
    }
    if (texts.length > MAX_CHUNKS_PER_REQUEST) {
        return res.status(400).json({ error: `Max ${MAX_CHUNKS_PER_REQUEST} texts per request` });
    }

    const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0] || 'anon').trim();
    const today = new Date().toISOString().slice(0, 10);

    // ── Pro/Team/Enterprise/trial: unlimited, same rule as /api/chat ───────────
    let unmetered = false;
    if (licenseKey && typeof licenseKey === 'string') {
        try {
            const license = await redis.get(`license:${licenseKey.trim().toUpperCase()}`);
            if (isLicenseActive(license)) unmetered = true;
        } catch (err) {
            console.error('License lookup error (embed):', err);
        }
    }

    const session = (!unmetered && authToken) ? verifySession(authToken) : null;
    const identityKey = session ? `gh:${session.sub}` : ((rawSession && typeof rawSession === 'string') ? rawSession : ip);
    const quotaKey = `embedquota:${identityKey.slice(0, 48)}:${today}`;

    if (!unmetered) {
        const used = parseInt((await redis.get(quotaKey).catch(() => null)) ?? '0', 10);
        if (used + texts.length > DAILY_CHUNK_LIMIT) {
            return res.status(429).json({
                error: 'Daily embedding limit reached. Switch to Ollama for unlimited local indexing, or try again tomorrow.',
                code: 'EMBED_QUOTA_EXCEEDED'
            });
        }
    }

    try {
        const requests = texts.map(t => ({
            model: `models/${EMBED_MODEL}`,
            content: { parts: [{ text: String(t).slice(0, MAX_CHUNK_CHARS) }] }
        }));

        const geminiRes = await fetch(EMBED_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests }),
            signal: AbortSignal.timeout(20_000)
        });

        if (!geminiRes.ok) {
            const errText = await geminiRes.text().catch(() => '');
            console.error('Gemini embedding error:', geminiRes.status, errText);
            return res.status(502).json({ error: 'Embedding provider error. Please try again.' });
        }

        const data = await geminiRes.json();
        const embeddings = (data.embeddings ?? []).map(e => e.values ?? []);

        if (!unmetered) {
            const pipeline = redis.pipeline();
            pipeline.incrby(quotaKey, texts.length);
            pipeline.expire(quotaKey, QUOTA_TTL);
            await pipeline.exec().catch(() => {});
        }

        return res.status(200).json({ embeddings });
    } catch (err) {
        console.error('Embedding request error:', err);
        return res.status(500).json({ error: 'Embedding request failed.' });
    }
}
