// test/quota-race.test.js — fires real concurrent requests at the shared
// quota logic (backend/lib/quota.js) and verifies the daily cap can't be
// overshot. This is a regression test for a real production incident: three
// unrelated users ended up with a quota reading of 21 instead of capping
// cleanly at 20, caused by a check-then-increment race (see quota.js's
// module comment for the full explanation).
//
// Uses a mock Redis client (test/mocks/upstash-redis.js) with a deliberate
// artificial delay on incr/decr — without that delay, concurrent async calls
// in a single-threaded test would never actually interleave, and this test
// would pass even against the OLD buggy code. The delay is what makes this a
// real test of the race, not a test that happens to pass either way.

const path = require('path');
const { Redis } = require('./mocks/upstash-redis.js');
const { suite, check, summary } = require('./helpers');

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'quota.js');
    const { quotaKeysFor, reserveQuota } = await import(`file://${modPath}`);

    const DAILY_LIMIT = 20; // must match backend/api/chat.js's DAILY_LIMIT

    suite('reserveQuota under real concurrency cannot exceed the daily cap');
    {
        const redis = Redis.fromEnv();
        const keys = quotaKeysFor('same-user-machine-id', '1.2.3.4', '2026-07-10');
        const limits = { dailyLimit: DAILY_LIMIT, ipDailyLimit: 200, globalDailyLimit: 0, quotaTtl: 86400, monitorTtl: 86400 };

        // 30 "simultaneous" requests from the SAME identity — e.g. two chat
        // panels open, a double-click, or someone deliberately trying to
        // exploit the race by firing many parallel requests at once.
        const CONCURRENT_REQUESTS = 30;
        const results = await Promise.all(
            Array.from({ length: CONCURRENT_REQUESTS }, () => reserveQuota(redis, keys, limits))
        );

        const allowed = results.filter(r => !r.blocked);
        const blocked = results.filter(r => r.blocked);

        check(`exactly ${DAILY_LIMIT} of ${CONCURRENT_REQUESTS} concurrent requests were allowed (not more)`, allowed.length === DAILY_LIMIT);
        check(`the remaining ${CONCURRENT_REQUESTS - DAILY_LIMIT} were correctly blocked`, blocked.length === CONCURRENT_REQUESTS - DAILY_LIMIT);

        const finalCount = await redis.get(keys.sessionQuotaKey);
        check(`the final stored count is exactly ${DAILY_LIMIT}, not 21 or higher (the actual production bug)`, parseInt(finalCount, 10) === DAILY_LIMIT);
    }

    suite('a blocked reservation is fully refunded (does not leak quota)');
    {
        const redis = Redis.fromEnv();
        const keys = quotaKeysFor('another-user', '5.6.7.8', '2026-07-10');
        const limits = { dailyLimit: 5, ipDailyLimit: 200, globalDailyLimit: 0, quotaTtl: 86400, monitorTtl: 86400 };

        for (let i = 0; i < 5; i++) await reserveQuota(redis, keys, limits); // use up the real quota
        const blockedResult = await reserveQuota(redis, keys, limits); // this one should be blocked + refunded

        check('the 6th request when the limit is 5 is blocked', blockedResult.blocked === true);
        const countAfterBlock = await redis.get(keys.sessionQuotaKey);
        check('the blocked request did not leave the counter incremented (refund worked)', parseInt(countAfterBlock, 10) === 5);
    }

    suite('a failed upstream request (refundQuota called manually) does not consume quota');
    {
        const redis = Redis.fromEnv();
        const { refundQuota } = await import(`file://${modPath}`);
        const keys = quotaKeysFor('third-user', '9.9.9.9', '2026-07-10');
        const limits = { dailyLimit: 20, ipDailyLimit: 200, globalDailyLimit: 0, quotaTtl: 86400, monitorTtl: 86400 };

        await reserveQuota(redis, keys, limits); // simulate a request that reserved...
        await refundQuota(redis, keys);          // ...then failed upstream and got refunded

        const count = await redis.get(keys.sessionQuotaKey);
        check('quota returns to 0 after a full reserve+refund cycle', parseInt(count, 10) === 0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
