// backend/lib/paddleSignature.js — checks the Paddle-Signature header on
// webhook calls. Paddle signs "<timestamp>:<raw body>" with HMAC-SHA256 using
// the endpoint's secret key, and sends it as "ts=<unix>;h1=<hex>".
//
// While a secret is being rotated Paddle sends one h1 per active secret
// ("ts=..;h1=..;h1=.."), so every h1 is checked and any match passes.
//
// Rejects anything older than the tolerance, so a captured request can't be
// replayed later. Pure function, so it can be tested without Paddle.

import { createHmac, timingSafeEqual } from 'crypto';

export const PADDLE_TOLERANCE_SECONDS = 300;

export function verifyPaddleSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!secret || !header || typeof header !== 'string') return false;

    let ts = NaN;
    const signatures = [];
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name === 'ts') ts = Number(value);
        else if (name === 'h1' && value) signatures.push(value);
    }
    if (!Number.isFinite(ts) || signatures.length === 0) return false;
    if (Math.abs(nowSeconds - ts) > PADDLE_TOLERANCE_SECONDS) return false;

    const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex'));
    return signatures.some(h1 => {
        const given = Buffer.from(h1);
        return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
