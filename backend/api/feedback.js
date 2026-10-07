import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// In-product feedback from the extension's chat view (thumbs on a result, a
// "what went wrong" note after a failure, or the always-available Feedback
// button). No email or other contact detail is collected.
//
// Payload: { rating?: 'up'|'down', reason?, text?, trigger, context?,
//            meta: { version, platform, backend, machineId } }
//
// Free text is stored here, never sent through /api/telemetry (whose `detail`
// field is a bounded classifier, not a place for user-written text). The
// extension never attaches code, prompts or file paths — only what the user
// typed in the box.
//
// Storage layout in Redis:
//   feedback:items:{YYYY-MM-DD}    list — JSON entries, newest first, capped at 1000/day
//   feedback:counts:{YYYY-MM-DD}   hash — "trigger:rating" and "reason:<reason>" → count
//   feedback:rate:{machineId}      string — per-device daily submission count (abuse guard)

const TRIGGERS = new Set(['result', 'failure', 'manual']);
const RATINGS = new Set(['up', 'down']);
const REASONS = new Set([
    'wrong_answer', 'too_slow', 'broke_code', 'other',
    'bug', 'idea', 'pricing'
]);
const MAX_TEXT = 500;
const MAX_PER_DEVICE_PER_DAY = 20;
const MAX_ITEMS_PER_DAY = 1000;
const TTL_SECONDS = 90 * 24 * 3600;

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body ?? {};
    const meta = body.meta ?? {};

    const trigger = String(body.trigger ?? '');
    if (!TRIGGERS.has(trigger)) return res.status(400).json({ error: 'Invalid trigger' });

    const rating = body.rating == null ? '' : String(body.rating);
    if (rating && !RATINGS.has(rating)) return res.status(400).json({ error: 'Invalid rating' });

    const reason = body.reason == null ? '' : String(body.reason);
    if (reason && !REASONS.has(reason)) return res.status(400).json({ error: 'Invalid reason' });

    const text = clip(body.text, MAX_TEXT);
    if (!rating && !text) return res.status(400).json({ error: 'Nothing to record' });

    const machineId = clip(meta.machineId, 64);
    const today = new Date().toISOString().slice(0, 10);

    try {
        if (machineId) {
            const rateKey = `feedback:rate:${machineId}:${today}`;
            const n = await redis.incr(rateKey);
            if (n === 1) await redis.expire(rateKey, 2 * 24 * 3600);
            if (n > MAX_PER_DEVICE_PER_DAY) return res.status(429).json({ error: 'Too many submissions' });
        }

        const rawCountry = req.headers['x-vercel-ip-country'];
        const country = (Array.isArray(rawCountry) ? rawCountry[0] : rawCountry) || null;

        const entry = {
            ts: Date.now(),
            trigger,
            rating: rating || null,
            reason: reason || null,
            text: text || null,
            // Bounded classifier for what the user was doing (an error code or
            // feature name) — same rules as telemetry `detail`.
            context: clip(body.context, 48) || null,
            machineId: machineId || null,
            version: clip(meta.version, 16) || null,
            platform: clip(meta.platform, 16) || null,
            backend: clip(meta.backend, 32) || null,
            country
        };

        const itemsKey = `feedback:items:${today}`;
        const countsKey = `feedback:counts:${today}`;
        const pipeline = redis.pipeline();
        pipeline.lpush(itemsKey, JSON.stringify(entry));
        pipeline.ltrim(itemsKey, 0, MAX_ITEMS_PER_DAY - 1);
        pipeline.expire(itemsKey, TTL_SECONDS);
        pipeline.hincrby(countsKey, `${trigger}:${rating || 'note'}`, 1);
        if (reason) pipeline.hincrby(countsKey, `reason:${reason}`, 1);
        pipeline.expire(countsKey, TTL_SECONDS);
        await pipeline.exec();

        return res.status(200).json({ ok: true });
    } catch (err) {
        // Feedback is best-effort; never surface a stack to the client.
        console.error('feedback error', err?.message);
        return res.status(500).json({ error: 'Could not record feedback' });
    }
}
