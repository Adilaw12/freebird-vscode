// backend/lib/paddleSignature.js — checks the Paddle-Signature header on
// webhook calls. Paddle signs "<timestamp>:<raw body>" with HMAC-SHA256 using
// the endpoint's secret key, and sends it as "ts=<unix>;h1=<hex>".
//
// Rejects anything older than the tolerance, so a captured request can't be
// replayed later. Pure function, so it can be tested without Paddle.

import { createHmac, timingSafeEqual } from 'crypto';

export const PADDLE_TOLERANCE_SECONDS = 300;

export function verifyPaddleSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!secret || !header || typeof header !== 'string') return false;

    const parts = Object.fromEntries(header.split(';').map(p => p.split('=', 2)));
    const ts = Number(parts.ts);
    const h1 = parts.h1;
    if (!Number.isFinite(ts) || !h1) return false;
    if (Math.abs(nowSeconds - ts) > PADDLE_TOLERANCE_SECONDS) return false;

    const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(h1);
    return a.length === b.length && timingSafeEqual(a, b);
}
