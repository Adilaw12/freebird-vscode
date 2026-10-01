// backend/api/xendit-recharge-cron.js — GET, Vercel Cron (see vercel.json,
// daily 03:00 UTC). Xendit does not auto-bill recurring e-wallet charges the
// way Stripe auto-bills subscriptions — this job is what actually drives
// monthly renewal, by issuing a payment_request against each due license's
// saved token.
//
// Redis state (license status, next-due-date, retry count) is ONLY ever
// mutated by xendit-webhook.js, never here — this job just issues charge
// requests and removes them from the due-queue immediately so a slow
// webhook response can't cause tomorrow's run to double-charge the same
// license. The webhook re-queues the key once the outcome (success or
// failure) is known.

import { Redis } from '@upstash/redis';
import { createPaymentRequest } from '../lib/xenditClient.js';
import { XENDIT_PLANS } from '../lib/xenditPricing.js';

const redis = Redis.fromEnv();

function isAuthorized(req) {
    const expected = process.env.CRON_SECRET || '';
    if (!expected) return false;
    return req.headers['authorization'] === `Bearer ${expected}`;
}

export default async function handler(req, res) {
    if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });

    // '-inf' is the Redis ZRANGE BYSCORE literal for "no lower bound" — the
    // JS value -Infinity does NOT survive Upstash's JSON-over-REST transport
    // (JSON.stringify(-Infinity) === "null"), so this must stay a string.
    const dueKeys = await redis.zrange('xendit:duequeue', '-inf', Date.now(), { byScore: true });

    let charged = 0;
    let skipped = 0;
    let failed = 0;

    for (const key of dueKeys) {
        // Remove first — see file header for why this ordering matters.
        await redis.zrem('xendit:duequeue', key).catch(() => {});

        try {
            const license = await redis.get(`license:${key}`);
            if (!license || license.status === 'cancelled') {
                skipped++;
                continue;
            }

            const plan = XENDIT_PLANS[license.country];
            if (!plan || !license.xenditPaymentMethodId) {
                console.error(`xendit-recharge-cron: cannot charge ${key} — missing plan/payment method`);
                failed++;
                continue;
            }

            await createPaymentRequest({
                referenceId: key,
                paymentMethodId: license.xenditPaymentMethodId,
                amount: plan.amount,
                currency: plan.currency,
            });
            charged++;
        } catch (err) {
            console.error(`xendit-recharge-cron: charge failed for ${key}:`, err?.message || err);
            failed++;
        }
    }

    console.log(`xendit-recharge-cron: ${dueKeys.length} due, ${charged} charge requests issued, ${skipped} skipped, ${failed} errored`);
    return res.status(200).json({ due: dueKeys.length, charged, skipped, failed });
}
