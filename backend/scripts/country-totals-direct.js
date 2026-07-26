// backend/scripts/country-totals-direct.js
//
// Same output as country-totals.js, but talks to Upstash directly instead of
// going through the password-protected /api/dashboard endpoint. Scans for
// every telemetry:countries:{date} key that still exists (90-day TTL — see
// TTL in api/telemetry.js) rather than assuming a fixed day-count window.
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node backend/scripts/country-totals-direct.js

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

async function main() {
    const keys = await redis.keys('telemetry:countries:*');

    if (keys.length === 0) {
        console.log('No telemetry:countries:* keys found.');
        return;
    }

    const perDay = await Promise.all(keys.map(key => redis.hgetall(key)));

    const totals = {};
    let grandTotal = 0;

    perDay.forEach((countries, i) => {
        for (const [country, count] of Object.entries(countries || {})) {
            const n = parseInt(count, 10) || 0;
            totals[country] = (totals[country] || 0) + n;
            grandTotal += n;
        }
    });

    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const dates = keys.map(k => k.replace('telemetry:countries:', '')).sort();

    console.log(`Days covered: ${dates[0]} to ${dates[dates.length - 1]} (${keys.length} days)\n`);
    console.log('Country'.padEnd(10) + 'Sessions');
    console.log('-'.repeat(20));
    for (const [country, count] of sorted) {
        console.log(country.padEnd(10) + count);
    }
    console.log('-'.repeat(20));
    console.log(`${sorted.length} countries, ${grandTotal} total sessions`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
