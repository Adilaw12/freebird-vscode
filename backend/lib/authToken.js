// backend/lib/authToken.js — signed session tokens for GitHub-verified identity
//
// Why: the old quota system trusted a client-reported "machine ID" string with
// no way to verify it belonged to a real, distinct install. Anyone could send
// a random sessionId and get a fresh daily quota. These tokens are issued by
// OUR server only (api/auth-github.js), after we've independently verified a
// GitHub access token against GitHub's API — so a token here always maps to
// one real GitHub account, which costs real effort to mint a new one of.
//
// Format: base64url(payload-json) + "." + base64url(HMAC-SHA256 signature)
// No external JWT library needed — this is intentionally minimal.

import { createHmac, timingSafeEqual } from 'crypto';

const SECRET = process.env.AUTH_SECRET || '';
const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function sign(payloadB64) {
    return createHmac('sha256', SECRET).update(payloadB64).digest();
}

/**
 * Issue a signed session token binding a verified GitHub user id.
 * @param {{ githubId: number|string, login: string }} identity
 * @param {number} [ttlSeconds]
 * @returns {string} signed token
 */
export function signSession({ githubId, login }, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!SECRET) {
        throw new Error('AUTH_SECRET is not configured on the server');
    }
    const now = Date.now();
    const payload = {
        sub:   String(githubId),
        login: String(login ?? ''),
        iat:   now,
        exp:   now + ttlSeconds * 1000
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sigB64      = sign(payloadB64).toString('base64url');
    return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a session token's signature and expiry.
 * @param {string} token
 * @returns {{ sub: string, login: string, iat: number, exp: number } | null}
 */
export function verifySession(token) {
    if (!SECRET || !token || typeof token !== 'string') return null;

    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64      = token.slice(dot + 1);
    if (!payloadB64 || !sigB64) return null;

    let provided;
    try {
        provided = Buffer.from(sigB64, 'base64url');
    } catch {
        return null;
    }

    const expected = sign(payloadB64);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }

    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
        return null;
    }

    return payload;
}
