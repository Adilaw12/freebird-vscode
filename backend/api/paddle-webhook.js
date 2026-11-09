// api/paddle-webhook.js — Paddle Billing webhook.
//
// HTTP layer only: verify the signature on the RAW body, drop duplicate
// deliveries, take a per-customer lock, then hand the event to
// lib/paddleProcess.js. Licences are written in the same shape as api/webhook.js
// (Stripe), so validate.js and the rest of the app don't care who sold them.
//
// Env: PADDLE_WEBHOOK_SECRET (the notification destination's secret key),
// PADDLE_API_KEY + PADDLE_ENV=sandbox|production (customer email lookup),
// PADDLE_PRICE_PRO_MONTHLY / _PRO_ANNUAL / _TEMPLATES / _TEAM, AUTH_SECRET.

import { Redis } from '@upstash/redis';
import { verifyPaddleSignature } from '../lib/paddleSignature.js';
import { processPaddleEvent } from '../lib/paddleProcess.js';

const redis = Redis.fromEnv();

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function countDaily(name) {
    const key = `telemetry:daily:${new Date().toISOString().slice(0, 10)}`;
    await redis.hincrby(key, name, 1).catch(() => {});
    await redis.expire(key, 90 * 24 * 60 * 60).catch(() => {});
}

// The transaction/subscription payloads carry customer_id only, so the email is fetched once.
async function fetchEmail(customerId) {
    const apiKey = process.env.PADDLE_API_KEY;
    if (!apiKey) return null;
    const base = process.env.PADDLE_ENV === 'sandbox' ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';
    const res = await fetch(`${base}/customers/${encodeURIComponent(customerId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data?.email ?? null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const rawBody = await getRawBody(req);
    if (!verifyPaddleSignature(rawBody, req.headers['paddle-signature'], process.env.PADDLE_WEBHOOK_SECRET)) {
        console.error('Paddle webhook: signature check failed');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Paddle retries and can deliver twice. The marker is set before processing and
    // removed again if processing fails, so a failed event is retried but a handled one is not.
    const eventMarker = event.event_id ? `paddle:event:${event.event_id}` : null;
    if (eventMarker) {
        const fresh = await redis.set(eventMarker, '1', { nx: true, ex: 7 * 24 * 60 * 60 });
        if (!fresh) return res.status(200).json({ received: true, duplicate: true });
    }

    // One event per customer at a time: licence updates are read-modify-write.
    const customerId = event.data?.customer_id;
    const lockKey = customerId ? `paddle:lock:${customerId}` : null;
    if (lockKey) {
        const locked = await redis.set(lockKey, '1', { nx: true, ex: 20 });
        if (!locked) {
            if (eventMarker) await redis.del(eventMarker).catch(() => {});
            return res.status(409).json({ error: 'Busy, retry' }); // Paddle retries
        }
    }

    try {
        const result = await processPaddleEvent(event, { redis, fetchEmail, countDaily });
        if (result.outcome === 'applied') console.log(`Paddle ${event.event_type} applied -> ${result.key}`);
        else console.log(`Paddle ${event.event_type}: ${result.outcome}`);
    } catch (err) {
        console.error(`Paddle webhook error for ${event.event_type}:`, err);
        if (eventMarker) await redis.del(eventMarker).catch(() => {});
        return res.status(500).json({ error: 'Webhook handler failed' }); // Paddle retries
    } finally {
        if (lockKey) await redis.del(lockKey).catch(() => {});
    }

    return res.status(200).json({ received: true });
}
