// api/upgrade-page.js — GET /upgrade?cadence=monthly|annual
// Creates a Stripe Checkout Session server-side (same routing as
// api/checkout.js, via lib/checkoutPricing.js) and redirects straight to
// it. This is what UPGRADE_URL (src/license/validator.ts) now points to —
// a single dynamic entry point instead of a hardcoded Payment Link, so
// every existing "Upgrade to Pro" button/warning-message action/markdown
// href gets the buyer's-country-aware price (India -> PPP + UPI) with zero
// extension-side changes at each call site.
//
// Previously referenced in vercel.json's /upgrade rewrite but never
// implemented — that rewrite was a dead link until this file existed.

import Stripe from 'stripe';
import { createCheckoutSession } from '../lib/checkoutPricing.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method not allowed');

    const cadence = req.query.cadence === 'annual' ? 'annual' : 'monthly';
    const rawCountry = req.headers['x-vercel-ip-country'];
    const country = (Array.isArray(rawCountry) ? rawCountry[0] : rawCountry) || null;
    const appUrl = process.env.APP_URL || 'https://freebird-backend.vercel.app';

    const { session, error } = await createCheckoutSession(stripe, { plan: 'pro', cadence, country, appUrl });

    res.setHeader('Content-Type', 'text/plain');
    if (error) return res.status(500).send(`Freebird checkout is temporarily unavailable — please try again shortly, or email support@ten-labs.com.au.\n\n(${error})`);

    res.writeHead(302, { Location: session.url });
    res.end();
}
