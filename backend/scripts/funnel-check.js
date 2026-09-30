// scripts/funnel-check.js — quick snapshot of the country checkout funnel
// over the last 14 days. Not a persisted cron artifact, just an ad-hoc check.
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

async function main() {
  const totals = {}; // country -> { quota_wall_shown, trial_started, upgrade_clicked, pro_subscribed }
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const key = `telemetry:countryFunnel:${date}`;
    const hash = await redis.hgetall(key);
    if (!hash) continue;
    for (const [field, count] of Object.entries(hash)) {
      const [country, event] = field.split(':');
      totals[country] ??= {};
      totals[country][event] = (totals[country][event] || 0) + Number(count);
    }
  }

  const rows = Object.entries(totals)
    .map(([country, ev]) => ({
      country,
      clicked: ev.upgrade_clicked || 0,
      subscribed: ev.pro_subscribed || 0,
    }))
    .filter((r) => r.clicked > 0 || r.subscribed > 0)
    .sort((a, b) => b.clicked - a.clicked);

  console.log('country  clicked  subscribed  (last 14 days)');
  for (const r of rows) {
    console.log(`${r.country.padEnd(8)} ${String(r.clicked).padEnd(8)} ${r.subscribed}`);
  }
  const totalClicked = rows.reduce((s, r) => s + r.clicked, 0);
  const totalSubscribed = rows.reduce((s, r) => s + r.subscribed, 0);
  console.log('--------------------');
  console.log(`${totalClicked} upgrade clicks, ${totalSubscribed} subscriptions across ${rows.length} countries`);
}

main();
