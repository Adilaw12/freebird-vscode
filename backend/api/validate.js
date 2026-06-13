import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Only allow requests from VS Code extension runtime and your own domains
const ALLOWED_ORIGINS = [
    'https://freebird.tenlabs.io',
    'vscode-webview://'  // VS Code webview origin
];

export default async function handler(req, res) {
    // CORS — restrict to known origins instead of wildcard
    const origin = req.headers['origin'] || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));

    // VS Code extension fetch() calls don't send an Origin header — allow those through
    // Block requests that DO send an Origin but it's not in our allowlist
    if (origin && !allowed) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    res.setHeader('Access-Control-Allow-Origin', allowed ? origin : '');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { key } = req.body ?? {};
    if (!key || typeof key !== 'string' || key.trim().length < 10) {
        return res.status(400).json({ error: 'Missing or invalid key' });
    }

    const normalised = key.trim().toUpperCase();

    // Basic format check — must match FB-XXXX-XXXX-XXXX-XXXX pattern
    if (!/^FB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalised)) {
        return res.status(200).json({ valid: false });
    }

    let license;
    try {
        license = await redis.get(`license:${normalised}`);
    } catch (err) {
        console.error('Redis error during validation:', err);
        // Don't fail open — return invalid if we can't check
        return res.status(500).json({ error: 'Validation service unavailable' });
    }

    if (!license || license.status !== 'active') {
        return res.status(200).json({ valid: false });
    }

    // Return only what the extension needs — don't leak internal fields
    return res.status(200).json({
        valid: true,
        email: license.email,
        plan: license.plan ?? 'pro',
        expiresAt: license.expiresAt ?? null
    });
}
