// test/usage-stats.test.js — Anthropic token-usage accounting (backend/lib/usageStats.js).
//
// The point of this module is a trustworthy cost number, so the tests pin the
// parts that could quietly make it wrong: reading both usage-bearing events,
// not double-counting input repeated on message_delta, splitting by audience
// and model family, tolerating streams with no usage, and the pricing maths
// (checked against the real console bill from 2026-10-05).

const path = require('path');
const { Redis } = require('./mocks/upstash-redis.js');
const { suite, check, summary } = require('./helpers');

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'usageStats.js');
    const {
        createUsageTracker, usageAudience, modelFamily, usageIncrements,
        recordUsage, usageKey, costOf, PRICES
    } = await import(`file://${modPath}`);

    suite('tracker reads message_start and the final message_delta');
    {
        const t = createUsageTracker();
        t.consume({ type: 'message_start', message: { usage: { input_tokens: 120, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0, output_tokens: 1 } } });
        t.consume({ type: 'content_block_delta', delta: { text: 'ignored' } });
        t.consume({ type: 'message_delta', usage: { output_tokens: 350 } });
        const s = t.snapshot();
        check('input side taken from message_start', s.input === 120 && s.cache_write === 4000 && s.cache_read === 0);
        check('output is the final cumulative figure, not the first', s.output === 350);
        check('marked as seen', s.seen === true);
    }

    suite('tracker does not double-count input repeated on message_delta');
    {
        const t = createUsageTracker();
        t.consume({ type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 3000, output_tokens: 1 } } });
        t.consume({ type: 'message_delta', usage: { input_tokens: 500, cache_read_input_tokens: 3000, output_tokens: 80 } });
        const s = t.snapshot();
        check('input stays 500, not 1000', s.input === 500);
        check('cache read stays 3000, not 6000', s.cache_read === 3000);
    }

    suite('tracker tolerates streams with no usage');
    {
        const t = createUsageTracker();
        t.consume(null); t.consume('x'); t.consume({ type: 'content_block_delta' }); t.consume({ type: 'message_start', message: {} });
        check('nothing seen', t.snapshot().seen === false);
        check('so nothing is written', usageIncrements(t.snapshot(), { audience: 'paid', kind: 'chat', family: 'haiku' }) === null);
    }

    suite('audience classification');
    {
        const base = { agentTrialReserved: false, unmetered: false, licensePlan: null, templateHaikuEligible: false, premiumReserved: false };
        check('free agent trial', usageAudience({ ...base, agentTrialReserved: true }) === 'agent_trial');
        check('template bonus', usageAudience({ ...base, templateHaikuEligible: true }) === 'template');
        check('paid plan', usageAudience({ ...base, unmetered: true, licensePlan: 'pro' }) === 'paid');
        check('7-day trial is separate from paid', usageAudience({ ...base, unmetered: true, licensePlan: 'trial' }) === 'trial');
        check('anything else', usageAudience(base) === 'other');
    }

    suite('model family');
    {
        check('haiku', modelFamily('claude-haiku-4-5-20251001') === 'haiku');
        check('sonnet', modelFamily('claude-sonnet-5') === 'sonnet');
        check('unknown/missing is "other", not a crash', modelFamily(undefined) === 'other' && modelFamily('gemini-3.1-flash-lite') === 'other');
    }

    suite('recordUsage accumulates per day, audience, kind and family');
    {
        const redis = Redis.fromEnv();
        const snap = { input: 100, cache_write: 0, cache_read: 900, output: 50, seen: true };
        const dims = { audience: 'agent_trial', kind: 'chat', family: 'haiku' };
        check('first write succeeds', await recordUsage(redis, '2026-10-06', snap, dims) === true);
        await recordUsage(redis, '2026-10-06', snap, dims);
        await recordUsage(redis, '2026-10-06', snap, { audience: 'paid', kind: 'completion', family: 'haiku' });

        const hash = redis.hashes.get(usageKey('2026-10-06'));
        check('requests counted per bucket', hash['agent_trial:chat:haiku:requests'] === 2 && hash['paid:completion:haiku:requests'] === 1);
        check('tokens summed per bucket', hash['agent_trial:chat:haiku:input'] === 200 && hash['agent_trial:chat:haiku:cache_read'] === 1800 && hash['agent_trial:chat:haiku:output'] === 100);
        check('zero-valued metrics are not written', !('agent_trial:chat:haiku:cache_write' in hash));
    }

    suite('recordUsage never throws — accounting must not break a response');
    {
        const broken = { pipeline() { throw new Error('redis down'); } };
        const origError = console.error;
        console.error = () => {};
        let result, threw = false;
        try { result = await recordUsage(broken, '2026-10-06', { input: 1, cache_write: 0, cache_read: 0, output: 1, seen: true }, { audience: 'paid', kind: 'chat', family: 'haiku' }); }
        catch { threw = true; }
        console.error = origError;
        check('swallows the error and reports false', threw === false && result === false);
    }

    suite('cost maths matches the real console bill');
    {
        // 2026-10-05 console, Haiku 4.5: 8,561,487 tokens in, 275,789 out, $9.98 total
        // (about $0.04 of which was Sonnet).
        const cost = costOf({ input: 8_561_487, cache_write: 0, cache_read: 0, output: 275_789 }, 'haiku');
        check('uncached Haiku prices reproduce the bill to within a few cents', Math.abs(cost - 9.94) < 0.01 && Math.abs(cost - 9.98) < 0.05);
        check('Haiku is $1 in / $5 out per million', PRICES.haiku.input === 1 && PRICES.haiku.output === 5);

        const cached = costOf({ input: 0, cache_write: 0, cache_read: 1_000_000, output: 0 }, 'haiku');
        check('cache reads cost a tenth of normal input', Math.abs(cached - 0.1) < 1e-9);
        const written = costOf({ input: 0, cache_write: 1_000_000, cache_read: 0, output: 0 }, 'haiku');
        check('cache writes cost 1.25x normal input', Math.abs(written - 1.25) < 1e-9);
        check('an unknown model family has no price (reported as n/a, not $0)', costOf({ input: 1, cache_write: 0, cache_read: 0, output: 1 }, 'other') === null);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
