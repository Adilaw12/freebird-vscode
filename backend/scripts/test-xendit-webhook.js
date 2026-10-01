// scripts/test-xendit-webhook.js — one-off smoke test of the Xendit webhook's
// Redis-writing logic (first charge, renewal, dunning) against REAL Redis,
// using a fake test key so it's easy to clean up. Does NOT exercise the
// payment_method.activated branch (that calls the real Xendit API). Not
// part of the app; run: node --env-file=<envfile> scripts/test-xendit-webhook.js

import { Redis } from '@upstash/redis';
import handler from '../api/xendit-webhook.js';

const redis = Redis.fromEnv();
const TEST_KEY = 'FB-ZTST-ZTST-ZTST-ZTST';
const TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || 'test-token-for-smoke-test';

function mockReq(event, data) {
    return {
        method: 'POST',
        headers: { 'x-callback-token': TOKEN },
        body: { event, data },
    };
}
function mockRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.end = () => res;
    return res;
}

async function cleanup() {
    await redis.del(`pending:xendit:${TEST_KEY}`);
    await redis.del(`license:${TEST_KEY}`);
    await redis.del(`customer:xendit-test-customer`);
    await redis.del(`session:${TEST_KEY}`);
    await redis.zrem('xendit:duequeue', TEST_KEY);
}

async function run() {
    process.env.XENDIT_WEBHOOK_TOKEN = TOKEN; // ensure isAuthorized() has something to compare against
    await cleanup();

    console.log('--- Setup: seed a pending checkout ---');
    await redis.set(`pending:xendit:${TEST_KEY}`, {
        email: 'test@example.com',
        country: 'ID',
        currency: 'IDR',
        channelCode: 'OVO',
        createdAt: new Date().toISOString(),
        xenditPaymentMethodId: 'pm-test-123',
    }, { ex: 3600 });

    console.log('--- Test 1: payment_request.succeeded (first charge) ---');
    let res = mockRes();
    await handler(mockReq('payment_request.succeeded', { reference_id: TEST_KEY, customer_id: 'xendit-test-customer' }), res);
    console.log('response:', res.statusCode, JSON.stringify(res.body));

    let license = await redis.get(`license:${TEST_KEY}`);
    console.log('license after first charge:', JSON.stringify(license));
    console.assert(license?.status === 'active', 'FAIL: expected status active');
    console.assert(license?.plan === 'pro', 'FAIL: expected plan pro');
    console.assert(license?.provider === 'xendit', 'FAIL: expected provider xendit');

    let pending = await redis.get(`pending:xendit:${TEST_KEY}`);
    console.assert(pending === null, 'FAIL: pending record should be deleted after promotion');

    let customer = await redis.get(`customer:xendit-test-customer`);
    console.assert(customer?.key === TEST_KEY, 'FAIL: customer record should map back to the key');

    let session = await redis.get(`session:${TEST_KEY}`);
    console.assert(session === TEST_KEY, 'FAIL: session record should equal the key');

    let queued = await redis.zrange('xendit:duequeue', '-inf', '+inf', { byScore: true });
    console.assert(queued.includes(TEST_KEY), 'FAIL: key should be in the due queue after first charge');

    console.log('--- Test 2: payment_request.succeeded (recurring renewal) ---');
    res = mockRes();
    await handler(mockReq('payment_request.succeeded', { reference_id: TEST_KEY }), res);
    license = await redis.get(`license:${TEST_KEY}`);
    console.log('license after renewal:', JSON.stringify(license));
    console.assert(license?.status === 'active', 'FAIL: expected status active after renewal');
    console.assert(license?.chargeRetryCount === 0, 'FAIL: retry count should reset on success');

    console.log('--- Test 3: payment_request.failed x1 (should go past_due, retry #1) ---');
    res = mockRes();
    await handler(mockReq('payment_request.failed', { reference_id: TEST_KEY }), res);
    license = await redis.get(`license:${TEST_KEY}`);
    console.log('license after 1st failure:', JSON.stringify(license));
    console.assert(license?.status === 'past_due', 'FAIL: expected past_due after 1st failure');
    console.assert(license?.chargeRetryCount === 1, 'FAIL: expected retry count 1');

    console.log('--- Test 4: payment_request.failed x3 more (should cancel on 4th total failure) ---');
    for (let i = 0; i < 3; i++) {
        res = mockRes();
        await handler(mockReq('payment_request.failed', { reference_id: TEST_KEY }), res);
    }
    license = await redis.get(`license:${TEST_KEY}`);
    console.log('license after 4 total failures:', JSON.stringify(license));
    console.assert(license?.status === 'cancelled', 'FAIL: expected cancelled after 4 total failures');

    console.log('--- Test 5: unauthorized request (bad token) should 403 ---');
    res = mockRes();
    const badReq = mockReq('payment_request.succeeded', { reference_id: TEST_KEY });
    badReq.headers['x-callback-token'] = 'wrong-token';
    await handler(badReq, res);
    console.log('response:', res.statusCode, JSON.stringify(res.body));
    console.assert(res.statusCode === 403, 'FAIL: expected 403 for bad token');

    await cleanup();
    console.log('--- Cleanup done. If no FAIL lines appeared above, all assertions passed. ---');
}

run().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
