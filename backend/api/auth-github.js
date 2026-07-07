// api/auth-github.js — verifies a GitHub access token and issues a signed
// Freebird session token.
//
// The extension runs the GitHub OAuth Device Flow directly against GitHub
// (no client secret needed for that step). Once it has a GitHub access token,
// it sends it here ONCE. We independently verify it by calling GitHub's own
// /user endpoint — we never trust a client-reported user id — then mint a
// signed session token binding the real GitHub user id. The extension stores
// that session token and sends it on every /api/chat and /api/fallback call
// instead of a self-reported machine id.

import { signSession } from '../lib/authToken.js';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { githubAccessToken } = req.body ?? {};
    if (!githubAccessToken || typeof githubAccessToken !== 'string') {
        return res.status(400).json({ error: 'githubAccessToken required' });
    }

    let ghUser;
    try {
        const ghRes = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${githubAccessToken}`,
                'User-Agent':  'freebird-ai-extension',
                Accept:        'application/vnd.github+json'
            },
            signal: AbortSignal.timeout(8000)
        });

        if (!ghRes.ok) {
            return res.status(401).json({ error: 'Invalid or expired GitHub token' });
        }
        ghUser = await ghRes.json();
    } catch (err) {
        console.error('GitHub verification error:', err);
        return res.status(502).json({ error: 'Could not reach GitHub to verify token' });
    }

    if (!ghUser?.id) {
        return res.status(401).json({ error: 'Invalid GitHub response' });
    }

    let sessionToken;
    try {
        sessionToken = signSession({ githubId: ghUser.id, login: ghUser.login });
    } catch (err) {
        console.error('Session signing error:', err.message);
        return res.status(500).json({ error: 'Server misconfigured', code: 'NO_AUTH_SECRET' });
    }

    return res.status(200).json({
        sessionToken,
        login:     ghUser.login,
        avatarUrl: ghUser.avatar_url ?? null
    });
}
