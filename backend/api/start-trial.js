// api/start-trial.js — self-serve 7-day Pro trial, no sign-in required.
//
// Replaces the old "email the founder" trial flow, and later the GitHub-
// sign-in-gated flow (telemetry showed that sign-in step alone was losing
// ~86% of everyone who reached it). Gated on the client's stable per-device
// machineId instead — same identity already used as the free-tier quota
// fallback. Trades some abuse-resistance for near-zero friction: machineId
// resets on reinstall, so a determined user could reclaim a trial. Accepted
// at current volume; revisit if scripted abuse actually shows up.

import { Redis } from '@upstash/redis';
import { generateKey } from '../lib/keygen.js';

// Same shape the extension checks (see isValidEmail in src/license/validator.ts).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { TRIAL_DAYS } from '../lib/license.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { machineId, email: rawEmail } = req.body ?? {};

    if (!machineId || typeof machineId !== 'string' || !machineId.trim()) {
        return res.status(400).json({ error: 'Missing device id.', code: 'MACHINE_ID_REQUIRED' });
    }
    const safeMachineId = machineId.trim().slice(0, 48);

    // Optional. Anything that isn't a plausible address is dropped, not rejected,
    // so a typo never blocks the trial itself.
    const email = typeof rawEmail === 'string' && rawEmail.trim().length <= 254 && EMAIL_PATTERN.test(rawEmail.trim())
        ? rawEmail.trim().toLowerCase()
        : null;

    const trialMarkerKey = `trial:machine:${safeMachineId}`;

    let existing;
    try {
        existing = await redis.get(trialMarkerKey);
    } catch (err) {
        console.error('Redis error checking trial eligibility:', err);
        return res.status(500).json({ error: 'Could not check trial eligibility. Please try again.' });
    }

    if (existing) {
        return res.status(409).json({ error: 'Free trial already used on this device.', code: 'TRIAL_USED' });
    }

    const key = generateKey('FBT');
    const now = Date.now();
    const trialEndsAt = now + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const nowIso = new Date(now).toISOString();

    const license = {
        machineId: safeMachineId,
        key,
        plan: 'trial',
        status: 'active',
        // Stored as an ISO string (like createdAt/updatedAt) so it's readable
        // directly in the Redis console instead of showing as a raw epoch-ms
        // number. isLicenseActive() parses this with new Date(), which handles
        // both this and the old raw-number format from trials created before
        // this change.
        trialEndsAt: new Date(trialEndsAt).toISOString(),
        // Used for trial reminders and account help only. Written only when given.
        ...(email && { email, emailCapturedAt: nowIso }),
        createdAt: nowIso,
        updatedAt: nowIso
    };

    try {
        await redis.set(`license:${key}`, license);
        // Permanent marker (no TTL) — one trial per device, ever.
        await redis.set(trialMarkerKey, { key, claimedAt: nowIso });

        // Funnel: trials sit between "quota wall shown" and "subscribed" —
        // tracked in the same daily hash so the dashboard can show adoption.
        const telemetryKey = `telemetry:daily:${new Date().toISOString().slice(0, 10)}`;
        await redis.hincrby(telemetryKey, 'trial_started', 1).catch(() => {});
        await redis.hincrby(telemetryKey, email ? 'trial_started_with_email' : 'trial_started_without_email', 1).catch(() => {});
        await redis.expire(telemetryKey, 90 * 24 * 60 * 60).catch(() => {});

        // Same event, broken down by country (same hash and key shape as
        // api/telemetry.js's countryFunnel) — trials were only counted globally
        // before, so a country's trial -> paid ratio couldn't be read.
        const rawCountry = req.headers['x-vercel-ip-country'];
        const country = (Array.isArray(rawCountry) ? rawCountry[0] : rawCountry) || null;
        if (country) {
            const funnelKey = `telemetry:countryFunnel:${new Date().toISOString().slice(0, 10)}`;
            await redis.hincrby(funnelKey, `${country.slice(0, 4)}:trial_started`, 1).catch(() => {});
            await redis.expire(funnelKey, 90 * 24 * 60 * 60).catch(() => {});
        }
    } catch (err) {
        console.error('Redis error creating trial license:', err);
        return res.status(500).json({ error: 'Could not create trial. Please try again.' });
    }

    console.log(`Freebird trial started: machine ${safeMachineId} -> ${key}`);
    return res.status(200).json({ key, trialEndsAt });
}
