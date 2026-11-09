// api/link-license.js — POST { authToken, key } -> { linked: true }
//
// One-time "save this licence to my account": for anyone holding a key (existing
// Stripe subscribers, Team seats handed out by an owner, a purchase made without
// signing in). After this they never type the key again.
//
// A key can belong to one GitHub account, and an account to one licence. Trials
// are machine-bound and cannot be linked.

import { Redis } from '@upstash/redis';
import { verifySession } from '../lib/authToken.js';
import { githubLicenseKey } from '../lib/licenseResolve.js';
import { handleCors } from '../lib/cors.js';

const redis = Redis.fromEnv();

const KEY_FORMAT = /^(FB|OP)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const LINKABLE_PLANS = ['pro', 'team', 'enterprise', 'templates'];
const MAX_ATTEMPTS_PER_HOUR = 20;

export default async function handler(req, res) {
    if (handleCors(req, res)) return;

    const session = verifySession(req.body?.authToken);
    if (!session) return res.status(401).json({ error: 'Sign in with GitHub first.', code: 'AUTH_REQUIRED' });

    const key = typeof req.body?.key === 'string' ? req.body.key.trim().toUpperCase() : '';
    if (!KEY_FORMAT.test(key)) return res.status(400).json({ error: 'That does not look like a Freebird licence key.', code: 'BAD_KEY' });

    try {
        // Guessing keys is hopeless (31^16), but cap attempts per account anyway.
        const attemptsKey = `ratelimit:link:${session.sub}`;
        const attempts = await redis.incr(attemptsKey);
        if (attempts === 1) await redis.expire(attemptsKey, 3600);
        if (attempts > MAX_ATTEMPTS_PER_HOUR) return res.status(429).json({ error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' });

        const license = await redis.get(`license:${key}`);
        if (!license) return res.status(404).json({ error: 'No licence found for that key.', code: 'NOT_FOUND' });
        if (!LINKABLE_PLANS.includes(license.plan) || !['active', 'past_due'].includes(license.status)) {
            return res.status(400).json({ error: 'That key is not an active paid licence.', code: 'NOT_LINKABLE' });
        }

        const githubId = String(session.sub);
        if (license.githubId && license.githubId !== githubId) {
            return res.status(409).json({ error: 'That key is already linked to another GitHub account. Email support@ten-labs.com.au if that is a mistake.', code: 'KEY_ALREADY_LINKED' });
        }

        // Claim the account's slot atomically; if it holds a different key, refuse.
        const claimed = await redis.set(githubLicenseKey(githubId), key, { nx: true });
        if (!claimed) {
            const current = await redis.get(githubLicenseKey(githubId));
            if (String(current).toUpperCase() !== key) {
                return res.status(409).json({ error: 'This GitHub account already has a Freebird licence linked.', code: 'ACCOUNT_ALREADY_HAS_LICENSE' });
            }
        }

        await redis.set(`license:${key}`, {
            ...license,
            githubId,
            githubLogin: session.login || license.githubLogin,
            updatedAt: new Date().toISOString()
        });
        return res.status(200).json({ linked: true, plan: license.plan });
    } catch (err) {
        console.error('link-license error:', err);
        return res.status(500).json({ error: 'Could not link the licence. Please try again.' });
    }
}
