#!/usr/bin/env node
// eval/floorplan/compare.js — node eval/floorplan/compare.js before.json after.json
// Per-brief and overall differences between two eval runs (see run.js).

const fs = require('fs');
const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('usage: node eval/floorplan/compare.js before.json after.json'); process.exit(1); }
const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
const byId = r => { const m = new Map(); for (const x of r.results) { if (!m.has(x.id)) m.set(x.id, []); m.get(x.id).push(x); } return m; };
const mA = byId(A), mB = byId(B);
const mean = xs => xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null;
const fmt = v => v === null ? '   –  ' : v.toFixed(1).padStart(6);
const rate = xs => xs.length ? Math.round(100 * xs.filter(Boolean).length / xs.length) + '%' : '–';

console.log(`before: ${a}  (${A.summary.model})\nafter:  ${b}  (${B.summary.model})\n`);
console.log('brief                 pass          seconds-to-valid       requests');
for (const id of new Set([...mA.keys(), ...mB.keys()])) {
    const ra = mA.get(id) ?? [], rb = mB.get(id) ?? [];
    const ta = mean(ra.map(r => r.timeToValidPlan).filter(v => v !== null)), tb = mean(rb.map(r => r.timeToValidPlan).filter(v => v !== null));
    console.log(`${id.padEnd(20)}  ${rate(ra.map(r => r.pass)).padStart(4)} → ${rate(rb.map(r => r.pass)).padEnd(4)}   ${fmt(ta)} → ${fmt(tb)}      ${fmt(mean(ra.map(r => r.requests)))} → ${fmt(mean(rb.map(r => r.requests)))}`);
}
const sa = A.summary, sb = B.summary;
console.log(`\noverall  pass ${Math.round(sa.passRate * 100)}% → ${Math.round(sb.passRate * 100)}%   valid ${Math.round(sa.validRate * 100)}% → ${Math.round(sb.validRate * 100)}%` +
    `   seconds ${sa.meanSecondsToValidPlan} → ${sb.meanSecondsToValidPlan}   requests ${sa.meanRequests} → ${sb.meanRequests}   warnings ${sa.meanWarnings} → ${sb.meanWarnings}`);
console.log('\nSmall samples are noisy: treat a single run as an indication, and use --repeat for decisions.');
