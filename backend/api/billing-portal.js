// api/billing-portal.js — opens Stripe's customer portal for a Pro subscriber, so
// they can cancel, change their card, or download invoices without contacting us.
//
// The license key is the only credential, the same one the extension already
// stores for Pro. Anyone holding the key can manage that subscription, which is
// the same trust the key already carries.

import Stripe from 'stripe';
import { Redis } from '@upstash/redis';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const redis  = Redis.fromEnv();

// Same origin rules as validate.js: the extension sends no Origin, and webviews
// send vscode-webview://.
const ALLOWED_ORIGINS = [
    'https://ten-labs.com.au',
    'vscode-webview://'
];

export default async function handler(req, res) {
    const origin = req.headers['origin'] || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    if (origin && !allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.setHeader('Access-Control-Allow-Origin', allowed ? origin : '');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { key } = req.body ?? {};
    if (!key || typeof key !== 'string' || !key.trim()) {
        return res.status(400).json({ error: 'Missing license key' });
    }

    let license;
    try {
        license = await redis.get(`license:${key.trim().toUpperCase()}`);
    } catch (err) {
        console.error('Redis error during billing portal lookup:', err);
        return res.status(500).json({ error: 'Billing service unavailable' });
    }

    // Trials and Xendit-paid licenses have no Stripe customer to open a portal for.
    if (!license?.stripeCustomerId) {
        return res.status(404).json({ error: 'No Stripe subscription is linked to this license.', code: 'NO_STRIPE_CUSTOMER' });
    }

    const appUrl = process.env.APP_URL || 'https://freebird-backend.vercel.app';
    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: license.stripeCustomerId,
            return_url: `${appUrl}/upgrade`
        });
        return res.status(200).json({ url: session.url });
    } catch (err) {
        console.error('Billing portal session failed:', err.message);
        return res.status(500).json({ error: 'Could not open the billing portal. Please try again.' });
    }
}
