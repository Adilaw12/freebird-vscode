// backend/scripts/country-funnel-full.js
//
// Read-only. Per-country sessions + checkout-funnel counts over every day the
// 90-day TTL still retains. Combines telemetry:countries:* (sessions) with
// telemetry:countryFunnel:* ("country:event" -> count).
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node backend/scripts/country-funnel-full.js
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

async function main() {
  const [sKeys, fKeys] = await Promise.all([
    redis.keys('telemetry:countries:*'),
    redis.keys('telemetry:countryFunnel:*'),
  ]);
  const rows = {};
  const row = (c) => (rows[c] ??= { sessions: 0, ev: {} });

  const sData = await Promise.all(sKeys.map((k) => redis.hgetall(k)));
  sData.forEach((h) => { for (const [c, n] of Object.entries(h || {})) row(c).sessions += Number(n) || 0; });

  const fData = await Promise.all(fKeys.map((k) => redis.hgetall(k)));
  const events = new Set();
  fData.forEach((h) => {
    for (const [field, n] of Object.entries(h || {})) {
      const i = field.indexOf(':');
      const c = field.slice(0, i), e = field.slice(i + 1);
      events.add(e);
      row(c).ev[e] = (row(c).ev[e] || 0) + (Number(n) || 0);
    }
  });

  const evList = [...events].sort();
  const dates = (ks, p) => ks.map((k) => k.replace(p, '')).sort();
  const sd = dates(sKeys, 'telemetry:countries:'), fd = dates(fKeys, 'telemetry:countryFunnel:');
  console.log(`sessions: ${sd[0]}..${sd.at(-1)} (${sKeys.length}d) | funnel: ${fd[0]}..${fd.at(-1)} (${fKeys.length}d)`);
  console.log(['country', 'sessions', ...evList].join('\t'));
  const sorted = Object.entries(rows).sort((a, b) => b[1].sessions - a[1].sessions);
  const tot = { sessions: 0 };
  for (const [c, r] of sorted) {
    console.log([c, r.sessions, ...evList.map((e) => r.ev[e] || 0)].join('\t'));
    tot.sessions += r.sessions;
    evList.forEach((e) => (tot[e] = (tot[e] || 0) + (r.ev[e] || 0)));
  }
  console.log(['TOTAL(' + sorted.length + ')', tot.sessions, ...evList.map((e) => tot[e] || 0)].join('\t'));
}
main().catch((e) => { console.error(e); process.exit(1); });
