// backend/api/xendit-checkout.js — POST, called by the /pay-local form.
// Validates the request against the country/channel whitelist (never trust
// a client-supplied amount), pre-generates the license key, stashes a
// pending record, and creates the Xendit payment token that starts the
// tokenize-then-charge flow (see backend/lib/xenditClient.js).

import { Redis } from '@upstash/redis';
import { generateKey } from '../lib/keygen.js';
import { resolvePlan } from '../lib/xenditPricing.js';
import { createPaymentToken } from '../lib/xenditClient.js';

const redis = Redis.fromEnv();

// Ten Labs' Xendit merchant registration was still pending as of 2026-10-02
// (submitted 2026-09-22, ~14 business days). Until it's approved, every
// createPaymentToken call below fails — which previously surfaced as a
// generic "Could not start checkout. Please try again." This read like a
// transient glitch, inviting repeat attempts that could never succeed.
// Flip XENDIT_MERCHANT_ACTIVE=true in Vercel once the account is live;
// until then this fails closed with an honest, specific message instead
// of attempting (and always failing) the real API call.
const MERCHANT_ACTIVE = process.env.XENDIT_MERCHANT_ACTIVE === 'true';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (!MERCHANT_ACTIVE) {
        return res.status(503).json({
            error: 'Local payment methods are launching soon for Vietnam/Indonesia — check back shortly, or use Upgrade to Pro in the meantime.',
            code: 'NOT_YET_AVAILABLE'
        });
    }

    const { email, country, channelCode } = req.body ?? {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const plan = resolvePlan(country, channelCode);
    if (!plan) {
        return res.status(400).json({ error: 'Unsupported country/payment method combination' });
    }

    const key = generateKey();

    try {
        await redis.set(`pending:xendit:${key}`, {
            email,
            country: plan.country,
            currency: plan.currency,
            channelCode,
            createdAt: new Date().toISOString(),
        }, { ex: 3600 }); // abandoned checkouts self-clean after 1h

        const token = await createPaymentToken({
            referenceId: key,
            country: plan.country,
            channelCode,
        });

        const redirectUrl = token?.actions?.[0]?.url;
        if (!redirectUrl) {
            console.error('xendit-checkout: no redirect action returned', JSON.stringify(token).slice(0, 300));
            return res.status(502).json({ error: 'Could not start checkout with that payment method. Please try again.' });
        }

        return res.status(200).json({ redirectUrl });
    } catch (err) {
        console.error('xendit-checkout error:', err?.message || err);
        return res.status(502).json({ error: 'Could not start checkout. Please try again.' });
    }
}
