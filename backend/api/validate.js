import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
    // CORS — allow the extension to call this from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { key } = req.body ?? {};
    if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'Missing key' });
    }

    const normalised = key.trim().toUpperCase();
    const license = await redis.get(`license:${normalised}`);

    if (!license || license.status !== 'active') {
        return res.status(200).json({ valid: false });
    }

    return res.status(200).json({
        valid: true,
        email: license.email,
        plan: license.plan ?? 'pro',
        expiresAt: license.expiresAt ?? null
    });
}
