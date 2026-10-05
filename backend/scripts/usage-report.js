// backend/scripts/usage-report.js
//
// Read-only. Reports Anthropic token usage and cost per request, from the
// telemetry:usage:{date} hashes api/chat.js writes (see lib/usageStats.js).
// Answers: what does a free agent-trial request cost, is prompt caching
// actually engaging, and how does Pro tab-completion traffic compare.
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node backend/scripts/usage-report.js [--since 2026-10-06]
//
// Only requests served after the usage accounting shipped appear here — older
// traffic was never recorded (use the Anthropic console for that).

import { Redis } from '@upstash/redis';
import { costOf } from '../lib/usageStats.js';

const redis = Redis.fromEnv();
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > -1 ? process.argv[sinceArg + 1] : '0000-00-00';

const ITERATIONS_PER_RUN = 8; // the client's cap on a free agent run

async function main() {
    const keys = (await redis.keys('telemetry:usage:*')).sort();
    const days = keys.map(k => k.slice('telemetry:usage:'.length)).filter(d => d >= since);
    if (days.length === 0) {
        console.log('No usage data yet. It accumulates once a backend containing lib/usageStats.js is deployed.');
        return;
    }

    // "audience:kind:family" -> { requests, input, cache_write, cache_read, output }
    const buckets = {};
    for (const day of days) {
        const hash = await redis.hgetall(`telemetry:usage:${day}`);
        for (const [field, n] of Object.entries(hash || {})) {
            const i = field.lastIndexOf(':');
            const bucket = field.slice(0, i), metric = field.slice(i + 1);
            buckets[bucket] ??= { requests: 0, input: 0, cache_write: 0, cache_read: 0, output: 0 };
            buckets[bucket][metric] += Number(n) || 0;
        }
    }

    console.log(`Days: ${days[0]} .. ${days.at(-1)} (${days.length} with data)\n`);
    const rows = [];
    let grand = 0;
    for (const [bucket, t] of Object.entries(buckets).sort((a, b) => b[1].requests - a[1].requests)) {
        const family = bucket.split(':')[2];
        const cost = costOf(t, family);
        const promptTokens = t.input + t.cache_write + t.cache_read;
        const hit = promptTokens ? t.cache_read / promptTokens : 0;
        if (cost !== null) grand += cost;
        rows.push({
            bucket,
            requests: t.requests,
            'avg prompt tok': Math.round(promptTokens / t.requests),
            'avg out tok': Math.round(t.output / t.requests),
            'cache hit': `${(hit * 100).toFixed(0)}%`,
            'cost $': cost === null ? 'n/a' : cost.toFixed(2),
            '$ / request': cost === null ? 'n/a' : (cost / t.requests).toFixed(4),
            [`$ / ${ITERATIONS_PER_RUN}-iteration run`]: cost === null ? 'n/a' : ((cost / t.requests) * ITERATIONS_PER_RUN).toFixed(2)
        });
    }
    console.table(rows);
    console.log(`Total recorded cost: $${grand.toFixed(2)}`);
    console.log('\nbucket = audience:kind:model. audiences: agent_trial (free agent runs), paid, trial, template, other.');
    console.log('"cache hit" = cache-read tokens / all prompt tokens. Near 0% on agent traffic means caching is not engaging.');
}

main().catch(err => { console.error(err); process.exit(1); });
