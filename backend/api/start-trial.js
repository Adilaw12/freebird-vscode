// api/start-trial.js — self-serve 7-day Pro trial, no email required.
//
// Replaces the old "email the founder" trial flow. Gated on a GitHub-verified
// session token (same identity used for the free-tier quota) so a trial can
// only be claimed once per real GitHub account, not once per install.

import { Redis } from '@upstash/redis';
import { verifySession } from '../lib/authToken.js';
import { generateKey } from '../lib/keygen.js';
import { TRIAL_DAYS } from '../lib/license.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { authToken } = req.body ?? {};
    const session = authToken ? verifySession(authToken) : null;

    if (!session) {
        return res.status(401).json({ error: 'Sign in with GitHub first.', code: 'AUTH_REQUIRED' });
    }

    const trialMarkerKey = `trial:gh:${session.sub}`;

    let existing;
    try {
        existing = await redis.get(trialMarkerKey);
    } catch (err) {
        console.error('Redis error checking trial eligibility:', err);
        return res.status(500).json({ error: 'Could not check trial eligibility. Please try again.' });
    }

    if (existing) {
        return res.status(409).json({ error: 'Free trial already used on this GitHub account.', code: 'TRIAL_USED' });
    }

    const key = generateKey();
    const now = Date.now();
    const trialEndsAt = now + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const nowIso = new Date(now).toISOString();

    const license = {
        githubId: session.sub,
        login: session.login,
        key,
        plan: 'trial',
        status: 'active',
        trialEndsAt,
        createdAt: nowIso,
        updatedAt: nowIso
    };

    try {
        await redis.set(`license:${key}`, license);
        // Permanent marker (no TTL) — one trial per GitHub account, ever.
        await redis.set(trialMarkerKey, { key, claimedAt: nowIso });

        // Funnel: trials sit between "quota wall shown" and "subscribed" —
        // tracked in the same daily hash so the dashboard can show adoption.
        const telemetryKey = `telemetry:daily:${new Date().toISOString().slice(0, 10)}`;
        await redis.hincrby(telemetryKey, 'trial_started', 1).catch(() => {});
        await redis.expire(telemetryKey, 90 * 24 * 60 * 60).catch(() => {});
    } catch (err) {
        console.error('Redis error creating trial license:', err);
        return res.status(500).json({ error: 'Could not create trial. Please try again.' });
    }

    console.log(`Freebird trial started: ${session.login} -> ${key}`);
    return res.status(200).json({ key, trialEndsAt });
}
