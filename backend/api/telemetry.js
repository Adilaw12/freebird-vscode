import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Accept batched telemetry events from the VS Code extension.
// Each event is a lightweight counter increment — no PII, no code content.
//
// Payload: { events: [{ name, count, ts }], meta: { version, platform, backend, sessionId, machineId } }
//
// Storage layout in Redis:
//   telemetry:daily:{YYYY-MM-DD}          hash  — event name → total count for the day
//   telemetry:backends:{YYYY-MM-DD}       hash  — backend name → count of sessions using it
//   telemetry:platforms:{YYYY-MM-DD}      hash  — platform → count
//   telemetry:versions:{YYYY-MM-DD}       hash  — extension version → count
//   telemetry:countries:{YYYY-MM-DD}      hash  — country code → count of sessions from it
//   telemetry:errors:{YYYY-MM-DD}         list  — error event names (capped)
//   telemetry:session:{sessionId}         string — "1", TTL 1 hour (dedup)
//   telemetry:machines:{YYYY-MM-DD}       set   — unique machineIds seen that day

// ollama_fallback deliberately excluded — it's a normal, expected routing
// event (quota exhausted → try Ollama → fall back to cloud), not a failure.
// Classifying it as an error made the dashboard look alarming when it was
// actually a sign of real usage.
const ERROR_EVENTS = new Set([
    'api_error', 'ollama_not_reachable',
    'commit_failed', 'push_failed', 'tool_error'
]);

export default async function handler(req, res) {
    // No CORS restriction — extension calls don't send Origin
    res.setHeader('Access-Control-Allow-Origin', '');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { events, meta } = req.body ?? {};

    if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'No events' });
    }
    if (events.length > 100) {
        return res.status(400).json({ error: 'Too many events (max 100)' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `telemetry:daily:${today}`;
    const backendsKey = `telemetry:backends:${today}`;
    const platformsKey = `telemetry:platforms:${today}`;
    const versionsKey = `telemetry:versions:${today}`;
    const countriesKey = `telemetry:countries:${today}`;
    const errorsKey = `telemetry:errors:${today}`;

    // Country from Vercel's own edge network — set automatically per request,
    // not client-reported, so it can't be spoofed the way a client-supplied
    // country field could. Same header used (and since reverted) for PPP
    // pricing; here it's purely observational, no pricing impact.
    const rawCountry = req.headers['x-vercel-ip-country'];
    const country = (Array.isArray(rawCountry) ? rawCountry[0] : rawCountry) || null;

    try {
        const pipeline = redis.pipeline();

        // Aggregate event counts
        for (const evt of events) {
            const name = String(evt.name ?? '').slice(0, 64);
            const count = Math.min(Math.max(parseInt(evt.count, 10) || 1, 1), 1000);
            if (!name) continue;

            pipeline.hincrby(dailyKey, name, count);

            if (ERROR_EVENTS.has(name)) {
                pipeline.lpush(errorsKey, `${name}:${count}:${Date.now()}`);
            }
        }

        // Track metadata dimensions (deduplicated per session)
        const sessionId = meta?.sessionId;
        if (sessionId) {
            const sessionKey = `telemetry:session:${String(sessionId).slice(0, 48)}`;
            const isNew = await redis.set(sessionKey, '1', { nx: true, ex: 3600 });

            if (isNew) {
                // First flush from this session — count dimensions once
                if (meta.backend) pipeline.hincrby(backendsKey, String(meta.backend).slice(0, 32), 1);
                if (meta.platform) pipeline.hincrby(platformsKey, String(meta.platform).slice(0, 32), 1);
                if (meta.version) pipeline.hincrby(versionsKey, String(meta.version).slice(0, 16), 1);
                if (country) pipeline.hincrby(countriesKey, country.slice(0, 4), 1);

                pipeline.hincrby(dailyKey, '_unique_sessions', 1);
            }
        }

        // Track unique machines per day (deduped via a daily Redis set).
        // machineId is stable across restarts, so this counts real users —
        // not relaunches, which inflate the per-session metric above.
        const machineId = meta?.machineId;
        if (machineId) {
            const machinesKey = `telemetry:machines:${today}`;
            const added = await redis.sadd(machinesKey, String(machineId).slice(0, 48));
            pipeline.expire(machinesKey, 90 * 24 * 60 * 60);
            if (added) pipeline.hincrby(dailyKey, '_unique_machines', 1);
        }

        // Expire all daily keys after 90 days
        const TTL = 90 * 24 * 60 * 60;
        pipeline.expire(dailyKey, TTL);
        pipeline.expire(backendsKey, TTL);
        pipeline.expire(platformsKey, TTL);
        pipeline.expire(versionsKey, TTL);
        pipeline.expire(countriesKey, TTL);
        pipeline.expire(errorsKey, TTL);

        // Cap error list
        pipeline.ltrim(errorsKey, 0, 499);

        await pipeline.exec();

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Telemetry ingest error:', err);
        return res.status(200).json({ ok: true }); // Don't fail the client
    }
}
