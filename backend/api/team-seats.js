// api/team-seats.js — minimal seat management for the Team plan
//
// Team plan is flat-priced (one Stripe subscription = one team, up to
// maxSeats). The owner's own license key doubles as their admin credential —
// consistent with how license keys already work everywhere else in this
// system (whoever holds the key controls it). No separate login needed.
//
// Actions:
//   POST { ownerLicenseKey, action: 'list' }
//   POST { ownerLicenseKey, action: 'add',    teammateEmail }
//   POST { ownerLicenseKey, action: 'remove', seatKey }

import { Redis } from '@upstash/redis';
import { generateKey } from '../lib/keygen.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { ownerLicenseKey, action, teammateEmail, seatKey } = req.body ?? {};

    if (!ownerLicenseKey || typeof ownerLicenseKey !== 'string') {
        return res.status(400).json({ error: 'ownerLicenseKey required' });
    }
    if (!['list', 'add', 'remove'].includes(action)) {
        return res.status(400).json({ error: 'action must be list, add, or remove' });
    }

    const normalisedOwnerKey = ownerLicenseKey.trim().toUpperCase();

    // ── Verify this key is an active team plan AND the owner (not a seat) ──────
    const ownerLicense = await redis.get(`license:${normalisedOwnerKey}`).catch(() => null);
    if (!ownerLicense || ownerLicense.status !== 'active' || ownerLicense.plan !== 'team') {
        return res.status(403).json({ error: 'Not an active Team license' });
    }
    if (ownerLicense.teamOwnerKey !== normalisedOwnerKey) {
        return res.status(403).json({ error: 'Only the team owner can manage seats. Ask them to run this from their own license key.' });
    }

    const team = await redis.get(`team:${normalisedOwnerKey}`).catch(() => null);
    if (!team) {
        return res.status(500).json({ error: 'Team record not found — contact support@ten-labs.com.au' });
    }

    // ── List ─────────────────────────────────────────────────────────────────
    if (action === 'list') {
        const seats = [];
        for (const key of team.seatKeys) {
            const lic = await redis.get(`license:${key}`).catch(() => null);
            seats.push({
                key,
                email:  lic?.email ?? '(unknown)',
                status: lic?.status ?? 'unknown',
                isOwner: key === normalisedOwnerKey
            });
        }
        return res.status(200).json({ maxSeats: team.maxSeats, usedSeats: team.seatKeys.length, seats });
    }

    // ── Add ──────────────────────────────────────────────────────────────────
    if (action === 'add') {
        if (!teammateEmail || typeof teammateEmail !== 'string' || !teammateEmail.includes('@')) {
            return res.status(400).json({ error: 'A valid teammateEmail is required' });
        }
        if (team.seatKeys.length >= team.maxSeats) {
            return res.status(409).json({ error: `Team is full (${team.maxSeats} seats). Remove a seat first or contact support to add more.` });
        }

        const newKey = generateKey();
        const seatLicense = {
            email:        teammateEmail.trim(),
            key:          newKey,
            plan:         'team',
            status:       'active',
            teamOwnerKey: normalisedOwnerKey,
            createdAt:    new Date().toISOString(),
            updatedAt:    new Date().toISOString()
        };

        await redis.set(`license:${newKey}`, seatLicense);
        await redis.set(`team:${normalisedOwnerKey}`, {
            ...team,
            seatKeys: [...team.seatKeys, newKey]
        });

        return res.status(200).json({
            key: newKey,
            email: seatLicense.email,
            usedSeats: team.seatKeys.length + 1,
            maxSeats: team.maxSeats
        });
    }

    // ── Remove ───────────────────────────────────────────────────────────────
    if (action === 'remove') {
        if (!seatKey || typeof seatKey !== 'string') {
            return res.status(400).json({ error: 'seatKey required' });
        }
        const normalisedSeatKey = seatKey.trim().toUpperCase();

        if (normalisedSeatKey === normalisedOwnerKey) {
            return res.status(400).json({ error: 'Cannot remove the owner seat — cancel the subscription instead.' });
        }
        if (!team.seatKeys.includes(normalisedSeatKey)) {
            return res.status(404).json({ error: 'That seat is not part of this team' });
        }

        const seatLicense = await redis.get(`license:${normalisedSeatKey}`).catch(() => null);
        if (seatLicense) {
            await redis.set(`license:${normalisedSeatKey}`, {
                ...seatLicense,
                status:    'revoked',
                updatedAt: new Date().toISOString()
            });
        }

        await redis.set(`team:${normalisedOwnerKey}`, {
            ...team,
            seatKeys: team.seatKeys.filter(k => k !== normalisedSeatKey)
        });

        return res.status(200).json({ removed: normalisedSeatKey, usedSeats: team.seatKeys.length - 1, maxSeats: team.maxSeats });
    }
}
