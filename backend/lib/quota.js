// backend/lib/quota.js — shared atomic quota logic for chat.js and fallback.js.
//
// Extracted for two reasons: chat.js and fallback.js previously duplicated
// this near-identically, and this is the core race-condition-prone logic in
// the whole free tier — worth being independently unit-testable with an
// injected Redis client, rather than only reachable through a full Vercel
// handler.

export function quotaKeysFor(identityKey, ip, today) {
    return {
        sessionQuotaKey: `quota:${identityKey.slice(0, 48)}:${today}`,
        ipQuotaKey:      `quota:ip:${ip}:${today}`,
        globalKey:       `quota:global:${today}`
    };
}

/**
 * Atomically reserves one unit of quota across all three counters (identity,
 * IP, global) BEFORE any slow/expensive work happens (e.g. calling the AI
 * provider) — deliberately NOT a check-then-increment pattern. Check-then-
 * increment reads the count, does slow work, and only increments after
 * success, leaving a race window spanning that entire slow operation where
 * concurrent requests from the same identity can all read the same stale
 * count, all pass the check, and all succeed — overshooting the cap. This is
 * exactly how real users ended up with a quota reading of 21 instead of
 * capping cleanly at 20. INCR is atomic per-key even inside a non-atomic
 * pipeline, so reserving first closes that window entirely.
 *
 * If the reservation pushes any counter over its limit, it's immediately
 * refunded before returning — callers just check `.blocked`.
 *
 * @param {object} redis - any client exposing pipeline()/incr/decr/expire
 *   matching @upstash/redis's interface (real or mocked)
 * @param {{sessionQuotaKey: string, ipQuotaKey: string, globalKey: string}} keys
 * @param {{dailyLimit: number, ipDailyLimit: number, globalDailyLimit: number, quotaTtl: number, monitorTtl: number}} limits
 */
export async function reserveQuota(redis, keys, limits) {
    const { sessionQuotaKey, ipQuotaKey, globalKey } = keys;
    const { dailyLimit, ipDailyLimit, globalDailyLimit, quotaTtl, monitorTtl } = limits;

    const reserve = redis.pipeline();
    reserve.incr(sessionQuotaKey);
    reserve.incr(ipQuotaKey);
    reserve.incr(globalKey);
    const [sessionUsed, ipUsed, globalUsed] = await reserve.exec();

    // Set TTL only the first time a key is created (fire-and-forget — a
    // missed TTL on a rare race just means that key expires a bit later
    // than intended, not a correctness issue).
    const ttl = redis.pipeline();
    if (sessionUsed === 1) ttl.expire(sessionQuotaKey, quotaTtl);
    if (ipUsed === 1) ttl.expire(ipQuotaKey, quotaTtl);
    if (globalUsed === 1) ttl.expire(globalKey, monitorTtl);
    await ttl.exec().catch(() => {});

    let blockReason = null;
    if (globalDailyLimit > 0 && globalUsed > globalDailyLimit) {
        blockReason = 'GLOBAL_CAPACITY';
    } else if (sessionUsed > dailyLimit || ipUsed > ipDailyLimit) {
        blockReason = 'QUOTA_EXCEEDED';
    }

    if (blockReason) {
        await refundQuota(redis, keys);
    }

    return { sessionUsed, ipUsed, globalUsed, blocked: blockReason !== null, blockReason };
}

/**
 * Same atomic reserve-then-refund pattern as reserveQuota, but for a single
 * counter — used by fallback.js's IP burst limiter, which only needs one key.
 */
export async function reserveSingleCounter(redis, key, limit, ttl) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttl).catch(() => {});

    if (count > limit) {
        await redis.decr(key).catch(() => {});
        return { count, blocked: true };
    }
    return { count, blocked: false };
}

/**
 * Refunds a reservation — call on any failure AFTER reserveQuota succeeded
 * (e.g. the upstream AI call itself failed), so nobody is charged for a
 * request that wasn't actually served.
 */
export async function refundQuota(redis, keys) {
    const { sessionQuotaKey, ipQuotaKey, globalKey } = keys;
    const refund = redis.pipeline();
    refund.decr(sessionQuotaKey);
    refund.decr(ipQuotaKey);
    refund.decr(globalKey);
    await refund.exec().catch(() => {});
}
