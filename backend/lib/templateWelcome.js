// backend/lib/templateWelcome.js — the 7-day "all prompt templates unlocked" window.
//
// Every device gets the full Template Library free for its first 7 days, then
// the catalog locks again (Pro / the standalone Template Library stay
// entitled as before). The window is anchored server-side to the first time we
// see the device's machine id, so reinstalling the extension can't restart it.
// The client may report when it was installed, but that is only ever allowed
// to make the window SHORTER (clamped to [now - 7 days, now]) — it can never
// push the start into the future, and the first value stored wins.
// The only thing a spoofed value could unlock is the template catalog itself.

export const WELCOME_DAYS = 7;
export const WELCOME_MS = WELCOME_DAYS * 24 * 60 * 60 * 1000;
const KEY_TTL_SECONDS = 400 * 24 * 60 * 60;

// Free Haiku-quality template runs per device per day. Outside the welcome
// window only the 3 free templates qualify, once a day; inside it every
// template qualifies, twice a day — the window exists so a new user can feel
// the best version of the library before access narrows after day 7, and a
// paid template answered by the cheaper model undersells it.
export const TEMPLATE_HAIKU_DAILY = 1;
export const TEMPLATE_HAIKU_DAILY_WELCOME = 2;

/**
 * Read-only: is this device inside its welcome window? Unlike getWelcomeEndsAt
 * this never starts a window, so a chat request can't be what opens one — only
 * a device that has already fetched the catalog (api/templates.js) has one.
 * @returns {Promise<number|null>} epoch ms the window ends, or null
 */
export async function peekWelcomeEndsAt(redis, machineId, now = Date.now()) {
    if (!machineId || typeof machineId !== 'string' || !machineId.trim()) return null;
    const first = await redis.get(`templates:welcome:${machineId.trim().slice(0, 48)}`);
    if (first === null || first === undefined) return null;
    const startMs = Number(first);
    if (!Number.isFinite(startMs)) return null;
    const endsAt = startMs + WELCOME_MS;
    return endsAt > now ? endsAt : null;
}

/**
 * How many free Haiku template runs per day this request may use: 0 if the
 * template doesn't qualify at all. templateId is client-supplied and only ever
 * trusted for routing — spoofing it buys at most this same capped allowance.
 * @param {string[]} freeIds - the 3 free built-in template ids
 * @param {string[]} allIds  - every template id (free + paid catalog)
 */
export async function templateHaikuDailyLimit(redis, { templateId, machineId, freeIds, allIds }, now = Date.now()) {
    if (!templateId || typeof templateId !== 'string') return 0;
    if (allIds.includes(templateId)) {
        // Only consult Redis when the window could matter (a paid template, or a
        // free one whose limit it would raise).
        let endsAt = null;
        try { endsAt = await peekWelcomeEndsAt(redis, machineId, now); } catch { /* fall back to the normal limit */ }
        if (endsAt !== null) return TEMPLATE_HAIKU_DAILY_WELCOME;
    }
    return freeIds.includes(templateId) ? TEMPLATE_HAIKU_DAILY : 0;
}

/**
 * @param {object} redis - @upstash/redis-compatible (get/set)
 * @param {unknown} machineId
 * @param {unknown} installedAtMs - client-reported install time, epoch ms (optional)
 * @returns {Promise<number|null>} epoch ms the window ends, or null if it is
 *   over / can't be determined (callers treat null as "not in the window")
 */
export async function getWelcomeEndsAt(redis, machineId, installedAtMs, now = Date.now()) {
    if (!machineId || typeof machineId !== 'string' || !machineId.trim()) return null;
    const key = `templates:welcome:${machineId.trim().slice(0, 48)}`;

    let first = await redis.get(key);
    if (first === null || first === undefined) {
        const claimed = Number(installedAtMs);
        const start = Number.isFinite(claimed)
            ? Math.min(now, Math.max(claimed, now - WELCOME_MS))
            : now;
        const created = await redis.set(key, start, { nx: true, ex: KEY_TTL_SECONDS });
        first = created ? start : await redis.get(key); // lost a race: use the winner's value
    }

    const startMs = Number(first);
    if (!Number.isFinite(startMs)) return null;
    const endsAt = startMs + WELCOME_MS;
    return endsAt > now ? endsAt : null;
}
