// backend/lib/linkToken.js — short-lived, signed "this checkout belongs to this
// GitHub account" tokens.
//
// The extension asks api/link-token.js for one (proving identity with its normal
// session token). The checkout page hands it to Paddle as custom data, and the
// Paddle webhook verifies it before attaching the purchase to that GitHub id.
// A plain ?uid=<id> in the URL can't do this job: anyone could type someone
// else's id.
//
// Kept separate from lib/authToken.js on purpose: the signed text is prefixed
// "link:" so a session token can never be replayed as a link token or the other
// way round, even though both use AUTH_SECRET. The secret is read on each call
// (not at import) so tests and misconfigured deployments fail clearly.

import { createHmac, timingSafeEqual } from 'crypto';

export const LINK_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour: long enough to finish a checkout

function secret() {
    const s = process.env.AUTH_SECRET || '';
    if (!s) throw new Error('AUTH_SECRET is not configured on the server');
    return s;
}

function mac(payloadB64) {
    return createHmac('sha256', secret()).update(`link:${payloadB64}`).digest();
}

/** @param {{ githubId: string|number, login?: string, plan?: string }} claims */
export function signLinkToken({ githubId, login, plan }, ttlSeconds = LINK_TOKEN_TTL_SECONDS, nowMs = Date.now()) {
    const payload = {
        typ: 'link',
        sub: String(githubId),
        login: String(login ?? ''),
        plan: String(plan ?? ''),
        exp: nowMs + ttlSeconds * 1000
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${b64}.${mac(b64).toString('base64url')}`;
}

/** @returns {{ sub: string, login: string, plan: string, exp: number } | null} */
export function verifyLinkToken(token, nowMs = Date.now()) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!b64 || !sig) return null;

    let expected;
    try { expected = mac(b64); } catch { return null; }
    let given;
    try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let payload;
    try { payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || payload.typ !== 'link' || !payload.sub || typeof payload.exp !== 'number' || nowMs > payload.exp) return null;
    return payload;
}
