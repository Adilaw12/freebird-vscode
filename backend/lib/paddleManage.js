// lib/paddleManage.js — Paddle's update-card / cancel links for a licence.
//
// Subscription webhooks do not carry management_urls, so they are fetched from the
// Paddle API the first time they are needed and saved on the licence record.
// The links are tied to the subscription, so a saved copy stays usable.

export function paddleBase(env = process.env.PADDLE_ENV) {
    return env === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
}

/** Sandbox portal links live on a sandbox-* host; live ones do not. */
export function linksMatchEnv(manage, env = process.env.PADDLE_ENV) {
    const urls = [manage?.update, manage?.cancel].filter(Boolean);
    if (urls.length === 0) return false;
    const wantSandbox = env === 'sandbox';
    return urls.every(u => /\/\/sandbox-/.test(u) === wantSandbox);
}

/** GET /subscriptions/{id} -> { update, cancel } or null. Never throws. */
export async function fetchManagementUrls(subId, { apiKey = process.env.PADDLE_API_KEY, env = process.env.PADDLE_ENV, fetchImpl = fetch } = {}) {
    if (!apiKey || !subId) return null;
    try {
        const res = await fetchImpl(`${paddleBase(env)}/subscriptions/${encodeURIComponent(subId)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) return null;
        const urls = (await res.json())?.data?.management_urls;
        if (!urls) return null;
        const manage = { update: urls.update_payment_method ?? null, cancel: urls.cancel ?? null };
        return manage.update || manage.cancel ? manage : null;
    } catch {
        return null;
    }
}

/**
 * Links for the subscription that sets the licence's plan. Uses the saved copy,
 * otherwise fetches and saves it. Returns null when there is nothing to manage.
 */
export async function resolveManageLinks(license, { redis, fetchUrls = fetchManagementUrls, env = process.env.PADDLE_ENV } = {}) {
    if (!license) return null;
    const entries = Object.entries(license.paddleSubscriptions ?? {}).filter(([, s]) => s.status !== 'cancelled');
    const picked = entries.find(([, s]) => s.plan === license.plan) ?? entries[0];
    if (!picked) return null;
    const [subId, sub] = picked;
    // A saved link from the other environment (a sandbox test licence in live) is never returned.
    if (sub.manage && linksMatchEnv(sub.manage, env)) return sub.manage;

    const manage = await fetchUrls(subId);
    if (!manage) return null;
    if (redis && license.key) {
        try {
            // Re-read so a webhook that landed meanwhile is not overwritten.
            const k = `license:${String(license.key).toUpperCase()}`;
            const fresh = await redis.get(k);
            if (fresh?.paddleSubscriptions?.[subId]) {
                fresh.paddleSubscriptions[subId].manage = manage;
                await redis.set(k, fresh);
            }
        } catch (err) {
            console.error('paddleManage: could not save links:', err?.message);
        }
    }
    return manage;
}
