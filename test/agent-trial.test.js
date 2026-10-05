// test/agent-trial.test.js — the free Agent-mode trial budget.
//
// Two halves: the SERVER budget (backend/lib/agentTrial.js) is the cost bound,
// so it must hold under concurrency and must never be shared with the daily
// chat quota; the CLIENT counter (src/license/agentTrial.ts) only drives the UI
// and must agree with the documented per-run numbers.

require('./bootstrap');
const path = require('path');
const { Redis } = require('./mocks/upstash-redis.js');
const { makeFakeContext, suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const clientTrial = require(path.join(OUT, 'license/agentTrial.js'));

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'agentTrial.js');
    const {
        reserveAgentTrial, refundAgentTrial, agentTrialKeys,
        AGENT_TRIAL_MAX_REQUESTS, AGENT_TRIAL_IP_DAILY
    } = await import(`file://${modPath}`);
    const quotaPath = path.join(__dirname, '..', 'backend', 'lib', 'quota.js');
    const { quotaKeysFor, reserveQuota } = await import(`file://${quotaPath}`);

    suite('server budget — lifetime cap per identity');
    {
        const redis = Redis.fromEnv();
        let allowed = 0;
        for (let i = 0; i < AGENT_TRIAL_MAX_REQUESTS + 10; i++) {
            const r = await reserveAgentTrial(redis, 'machine-a', 'iphash-a', '2026-10-05');
            if (!r.blocked) allowed++;
        }
        check(`exactly ${AGENT_TRIAL_MAX_REQUESTS} requests are allowed, the rest refused`, allowed === AGENT_TRIAL_MAX_REQUESTS);

        const next = await reserveAgentTrial(redis, 'machine-a', 'iphash-a', '2026-10-06'); // a different day
        check('the cap is lifetime, not daily — a new day does not reset it', next.blocked && next.code === 'AGENT_TRIAL_EXHAUSTED');

        const other = await reserveAgentTrial(redis, 'machine-b', 'iphash-b', '2026-10-05');
        check('a different identity has its own budget', !other.blocked);
    }

    suite('server budget — concurrency cannot overshoot the cap');
    {
        const redis = Redis.fromEnv();
        const results = await Promise.all(
            Array.from({ length: 60 }, () => reserveAgentTrial(redis, 'racey', 'iphash-r', '2026-10-05'))
        );
        const allowed = results.filter(r => !r.blocked).length;
        check(`60 simultaneous requests allow exactly ${AGENT_TRIAL_MAX_REQUESTS}`, allowed === AGENT_TRIAL_MAX_REQUESTS);
    }

    suite('server budget — remaining count reported to the client');
    {
        const redis = Redis.fromEnv();
        const first = await reserveAgentTrial(redis, 'counting', 'iphash-c', '2026-10-05');
        const second = await reserveAgentTrial(redis, 'counting', 'iphash-c', '2026-10-05');
        check('first request leaves cap-1', first.remaining === AGENT_TRIAL_MAX_REQUESTS - 1);
        check('second request leaves cap-2', second.remaining === AGENT_TRIAL_MAX_REQUESTS - 2);
    }

    suite('server budget — per-IP daily limit stops machine-id resets');
    {
        const redis = Redis.fromEnv();
        let allowed = 0, lastCode = null;
        // Every request uses a brand-new identity (a reset/reinstall each time)
        // from the same network.
        for (let i = 0; i < AGENT_TRIAL_IP_DAILY + 15; i++) {
            const r = await reserveAgentTrial(redis, `fresh-${i}`, 'shared-ip', '2026-10-05');
            if (r.blocked) lastCode = r.code; else allowed++;
        }
        check(`only ${AGENT_TRIAL_IP_DAILY} requests per IP per day get through`, allowed === AGENT_TRIAL_IP_DAILY);
        check('refusals are the rate-limit code, not "exhausted"', lastCode === 'AGENT_TRIAL_RATE_LIMITED');

        const keys = agentTrialKeys('fresh-70', 'shared-ip', '2026-10-05');
        check('a request blocked by the IP limit refunds the identity counter', (redis.counters.get(keys.idKey) ?? 0) === 0);
    }

    suite('server budget — failed upstream requests are refunded');
    {
        const redis = Redis.fromEnv();
        const r = await reserveAgentTrial(redis, 'refundee', 'iphash-f', '2026-10-05');
        check('reservation succeeded', !r.blocked && redis.counters.get(r.keys.idKey) === 1);
        await refundAgentTrial(redis, r.keys);
        check('identity counter back to 0 after refund', redis.counters.get(r.keys.idKey) === 0);
        check('IP counter back to 0 after refund', redis.counters.get(r.keys.ipKey) === 0);
    }

    suite('server budget — independent of the daily chat quota');
    {
        const redis = Redis.fromEnv();
        for (let i = 0; i < 5; i++) await reserveAgentTrial(redis, 'same-user', 'iphash-q', '2026-10-05');
        const keys = quotaKeysFor('same-user', '1.2.3.4', '2026-10-05');
        const chat = await reserveQuota(redis, keys, { dailyLimit: 10, ipDailyLimit: 200, globalDailyLimit: 0, quotaTtl: 86400, monitorTtl: 86400 });
        check('burning trial requests leaves the first chat request allowed and counted as #1', !chat.blocked && chat.sessionUsed === 1);
    }

    suite('client counter');
    {
        const ctx = makeFakeContext();
        check('cloud users start with 3 free runs', clientTrial.getAgentTrialRunsLeft(ctx, false) === 3);
        check('BYOK users start with 5 (their own key pays)', clientTrial.getAgentTrialRunsLeft(ctx, true) === 5);

        await clientTrial.recordAgentTrialRun(ctx);
        await clientTrial.recordAgentTrialRun(ctx);
        check('two runs used -> 1 left on cloud', clientTrial.getAgentTrialRunsLeft(ctx, false) === 1);
        check('the same two runs -> 3 left on BYOK', clientTrial.getAgentTrialRunsLeft(ctx, true) === 3);

        await clientTrial.recordAgentTrialRun(ctx);
        await clientTrial.recordAgentTrialRun(ctx);
        check('never goes negative', clientTrial.getAgentTrialRunsLeft(ctx, false) === 0);

        const ctx2 = makeFakeContext();
        await clientTrial.markAgentTrialExhausted(ctx2);
        check('server-reported exhaustion zeroes both cloud and BYOK', clientTrial.getAgentTrialRunsLeft(ctx2, false) === 0 && clientTrial.getAgentTrialRunsLeft(ctx2, true) === 0);

        check('a free run is capped at 8 loop iterations', clientTrial.AGENT_TRIAL_MAX_ITERATIONS === 8);
        check('server request budget covers 3 full runs at that cap', AGENT_TRIAL_MAX_REQUESTS >= clientTrial.FREE_AGENT_RUNS_CLOUD * clientTrial.AGENT_TRIAL_MAX_ITERATIONS);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
