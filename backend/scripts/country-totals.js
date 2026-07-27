// backend/scripts/country-totals.js
//
// Sums telemetry:countries:{date} across the full retained window (telemetry
// keys carry a 90-day TTL — see TTL in api/telemetry.js) and prints a total
// session count per country, sorted highest first.
//
// Reuses the existing password-protected /api/dashboard?json endpoint instead
// of talking to Upstash directly, so no Redis credentials are needed here —
// just the same DASHBOARD_PASSWORD already used to view the dashboard.
//
// Usage:
//   DASHBOARD_PASSWORD=... node backend/scripts/country-totals.js
//   DASHBOARD_PASSWORD=... API_BASE=https://freebird-backend.vercel.app node backend/scripts/country-totals.js

const API_BASE = process.env.API_BASE || 'https://freebird-backend.vercel.app';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';

async function main() {
    if (!PASSWORD) {
        console.error('Set DASHBOARD_PASSWORD in the environment before running this script.');
        process.exit(1);
    }

    const auth = 'Basic ' + Buffer.from('admin:' + PASSWORD).toString('base64');
    const res = await fetch(`${API_BASE}/api/dashboard?json=1&days=90`, {
        headers: { Authorization: auth }
    });

    if (!res.ok) {
        console.error(`Dashboard request failed: ${res.status} ${res.statusText}`);
        process.exit(1);
    }

    const data = await res.json();
    const totals = {};
    let grandTotal = 0;

    for (const day of data.days || []) {
        for (const [country, count] of Object.entries(day.countries || {})) {
            const n = parseInt(count, 10) || 0;
            totals[country] = (totals[country] || 0) + n;
            grandTotal += n;
        }
    }

    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

    console.log(`Window: last ${data.days?.length ?? 0} days (90-day retention cap)\n`);
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
