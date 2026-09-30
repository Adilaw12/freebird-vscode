// api/checkout.js — creates a Stripe Checkout Session dynamically, so the
// price shown is chosen server-side (plan + cadence + the buyer's own
// country) instead of the extension opening one of several hardcoded
// Payment Link URLs. Used by src/license/validator.ts's startProCheckout
// where JS can make a fetch call; see api/upgrade-page.js for the plain-
// link/redirect equivalent used everywhere else (including UPGRADE_URL).
//
// Request:  POST { plan?: 'pro', cadence?: 'monthly' | 'annual' }
// Response: { url: string } | { error: string }
//
// Country/region routing: India gets its own PPP-priced, UPI-enabled Price —
// see lib/checkoutPricing.js for why Adaptive Pricing can't do this (no
// manual discount, and UPI is explicitly excluded for cross-border
// subscriptions). Sourced from Vercel's edge-set x-vercel-ip-country header,
// same trustworthy (non-spoofable) mechanism telemetry.js already uses.

import Stripe from 'stripe';
import { createCheckoutSession } from '../lib/checkoutPricing.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { plan, cadence } = req.body ?? {};
    const rawCountry = req.headers['x-vercel-ip-country'];
    const country = (Array.isArray(rawCountry) ? rawCountry[0] : rawCountry) || null;
    const appUrl = process.env.APP_URL || 'https://freebird-backend.vercel.app';

    const { session, error, status } = await createCheckoutSession(stripe, { plan, cadence, country, appUrl });
    if (error) return res.status(status ?? 500).json({ error });

    return res.status(200).json({ url: session.url });
}
