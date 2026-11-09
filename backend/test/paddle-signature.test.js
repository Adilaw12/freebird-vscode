// test/paddle-signature.test.js — Paddle webhook signature checks.

import { createHmac } from 'crypto';
import { verifyPaddleSignature, PADDLE_TOLERANCE_SECONDS } from '../lib/paddleSignature.js';

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

const secret = 'pdl_ntfset_test_secret';
const body = '{"event_type":"subscription.created"}';
const now = 1_800_000_000;
const h1 = (ts, payload = body, key = secret) => createHmac('sha256', key).update(`${ts}:${payload}`).digest('hex');
const sign = (ts, payload = body, key = secret) => `ts=${ts};h1=${h1(ts, payload, key)}`;

console.log('\n--- Paddle webhook signatures ---');
check('a correct, fresh signature is accepted', verifyPaddleSignature(body, sign(now), secret, now));
check('a tampered body is rejected', !verifyPaddleSignature(body + ' ', sign(now), secret, now));
check('a signature from the wrong secret is rejected', !verifyPaddleSignature(body, sign(now, body, 'other'), secret, now));
check('an old timestamp is rejected (replay)', !verifyPaddleSignature(body, sign(now - PADDLE_TOLERANCE_SECONDS - 1), secret, now));
check('a future timestamp beyond tolerance is rejected', !verifyPaddleSignature(body, sign(now + PADDLE_TOLERANCE_SECONDS + 1), secret, now));
check('a missing header is rejected', !verifyPaddleSignature(body, undefined, secret, now));
check('a header with no h1 is rejected', !verifyPaddleSignature(body, `ts=${now}`, secret, now));
check('no configured secret means reject everything', !verifyPaddleSignature(body, sign(now), '', now));
// During secret rotation Paddle sends one h1 per active secret.
check('rotation: second h1 matching is accepted', verifyPaddleSignature(body, `ts=${now};h1=${h1(now, body, 'old')};h1=${h1(now)}`, secret, now));
check('rotation: first h1 matching is accepted', verifyPaddleSignature(body, `ts=${now};h1=${h1(now)};h1=${h1(now, body, 'old')}`, secret, now));
check('rotation: no h1 matching is rejected', !verifyPaddleSignature(body, `ts=${now};h1=${h1(now, body, 'a')};h1=${h1(now, body, 'b')}`, secret, now));

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
