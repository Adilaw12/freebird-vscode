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
