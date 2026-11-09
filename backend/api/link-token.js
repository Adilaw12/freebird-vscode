// api/link-token.js — POST { authToken, plan } -> { url }
//
// Called by the extension when a signed-in user clicks Upgrade. Returns the
// checkout page URL carrying a short-lived signed token that names their GitHub
// account, so the purchase lands on that account without anyone typing a key.
// Also stops purchases that would double-charge (Templates while on Pro, etc.)
// and refuses sanctioned countries before the buyer gets to Paddle.

import { Redis } from '@upstash/redis';
import { verifySession } from '../lib/authToken.js';
import { signLinkToken, LINK_TOKEN_TTL_SECONDS } from '../lib/linkToken.js';
import { githubLicenseKey } from '../lib/licenseResolve.js';
import { CHECKOUT_PLANS, purchaseBlockReason } from '../lib/paddleLicense.js';
import { isBlockedCountry } from '../lib/sanctionedCountries.js';
import { handleCors } from '../lib/cors.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    if (handleCors(req, res)) return;

    const { authToken, plan } = req.body ?? {};
    const session = verifySession(authToken);
    if (!session) {
        return res.status(401).json({ error: 'Sign in with GitHub to upgrade.', code: 'AUTH_REQUIRED' });
    }
    if (!CHECKOUT_PLANS.includes(plan)) {
        return res.status(400).json({ error: `plan must be one of: ${CHECKOUT_PLANS.join(', ')}`, code: 'BAD_PLAN' });
    }

    const rawCountry = req.headers['x-vercel-ip-country'];
    const country = (Array.isArray(rawCountry) ? rawCountry[0] : rawCountry) || null;
    if (isBlockedCountry(country)) {
        return res.status(403).json({ error: 'Freebird is not available for purchase in your country.', code: 'COUNTRY_BLOCKED' });
    }

    try {
        const key = await redis.get(githubLicenseKey(session.sub));
        const license = key ? await redis.get(`license:${String(key).toUpperCase()}`) : null;
        const blocked = purchaseBlockReason(license, plan);
        if (blocked) return res.status(409).json({ error: blocked.message, code: blocked.code });
    } catch (err) {
        console.error('link-token: licence lookup failed:', err);
        return res.status(500).json({ error: 'Could not check your account. Please try again.' });
    }

    let token;
    try {
        token = signLinkToken({ githubId: session.sub, login: session.login, plan });
    } catch (err) {
        console.error('link-token: signing failed:', err.message);
        return res.status(500).json({ error: 'Server misconfigured', code: 'NO_AUTH_SECRET' });
    }

    const base = process.env.CHECKOUT_PAGE_URL || 'https://ten-labs.com.au/freebird-upgrade.html';
    const url = `${base}?plan=${encodeURIComponent(plan)}&t=${encodeURIComponent(token)}`;
    return res.status(200).json({ url, expiresInSeconds: LINK_TOKEN_TTL_SECONDS });
}
