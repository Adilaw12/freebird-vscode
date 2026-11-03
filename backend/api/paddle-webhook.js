// api/paddle-webhook.js — Paddle webhook for Pro subscriptions. Writes licences
// in the same shape as api/webhook.js (Stripe), so validate.js and the rest of
// the app don't need to know which provider sold the licence.
//
// Verify against Paddle's sandbox payloads before going live: field names
// below (customer email, subscription status) follow Paddle Billing's documented
// shapes but haven't been checked against real events yet.

import { Redis } from '@upstash/redis';
import { generateKey } from '../lib/keygen.js';
import { verifyPaddleSignature } from '../lib/paddleSignature.js';
import { licenseStatusForPaddle } from '../lib/paddleLicense.js';

const redis = Redis.fromEnv();

async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

export const config = { api: { bodyParser: false } };

async function countDaily(name) {
    const key = `telemetry:daily:${new Date().toISOString().slice(0, 10)}`;
    await redis.hincrby(key, name, 1).catch(() => {});
    await redis.expire(key, 90 * 24 * 60 * 60).catch(() => {});
}

// Finds or creates the licence for a Paddle customer, keyed by Paddle customer id.
async function licenseForCustomer(customerId, email) {
    const existing = await redis.get(`paddle:customer:${customerId}`);
    if (existing?.key) {
        return { key: existing.key, license: await redis.get(`license:${existing.key}`), isNew: false };
    }
    const key = generateKey();
    const now = new Date().toISOString();
    const license = {
        email: email || null,
        key,
        plan: 'pro',
        provider: 'paddle',
        paddleCustomerId: customerId,
        status: 'active',
        createdAt: now,
        updatedAt: now
    };
    await redis.set(`paddle:customer:${customerId}`, { key, email: license.email, createdAt: now });
    return { key, license, isNew: true };
}

async function updateLicense(key, changes) {
    const license = await redis.get(`license:${key}`);
    if (!license) return;
    await redis.set(`license:${key}`, { ...license, ...changes, updatedAt: new Date().toISOString() });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const rawBody = await getRawBody(req);
    const signature = req.headers['paddle-signature'];
    if (!verifyPaddleSignature(rawBody, signature, process.env.PADDLE_WEBHOOK_SECRET)) {
        console.error('Paddle webhook: signature check failed');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
    }

    const data = event.data ?? {};
    const customerId = data.customer_id;
    const email = data.customer?.email ?? null;

    try {
        switch (event.event_type) {
            case 'transaction.completed': {
                if (!customerId) break;
                const { key, isNew } = await licenseForCustomer(customerId, email);
                // The success page finds the key by transaction id, the same way it finds
                // a Stripe checkout session. Two hours, like the Stripe mapping.
                if (data.id) await redis.set(`session:${data.id}`, key, { ex: 7200 });
                if (isNew) {
                    await countDaily('pro_subscribed');
                    console.log(`Paddle pro activated: ${email ?? customerId} -> ${key}`);
                } else {
                    await updateLicense(key, { status: 'active', pastDueSince: null });
                    await countDaily('subscription_renewed');
                }
                break;
            }

            case 'transaction.payment_failed': {
                if (!customerId) break;
                const { key, license } = await licenseForCustomer(customerId, email);
                if (license) {
                    await updateLicense(key, { status: 'past_due', pastDueSince: license.pastDueSince ?? new Date().toISOString() });
                }
                await countDaily('payment_failed');
                break;
            }

            case 'subscription.created':
            case 'subscription.updated':
            case 'subscription.canceled': {
                if (!customerId) break;
                const status = licenseStatusForPaddle(data.status);
                if (!status) break;
                const { key, license } = await licenseForCustomer(customerId, email);
                if (!license) break;
                const pastDueSince = status === 'past_due' ? (license.pastDueSince ?? new Date().toISOString()) : null;
                await updateLicense(key, { status, pastDueSince, paddleSubscriptionId: data.id });
                if (event.event_type === 'subscription.canceled') await countDaily('subscription_cancelled');
                break;
            }

            default:
                break; // events we don't handle are acknowledged and ignored
        }
    } catch (err) {
        console.error(`Paddle webhook error for ${event.event_type}:`, err);
        return res.status(500).json({ error: 'Webhook handler failed' }); // Paddle retries
    }

    return res.status(200).json({ received: true });
}
