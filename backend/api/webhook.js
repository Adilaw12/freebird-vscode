import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { generateKey } from '../lib/keygen.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const redis  = Redis.fromEnv();

// Read raw body for Stripe signature verification
async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end',  () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const rawBody = await getRawBody(req);
    const sig     = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Stripe webhook signature error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {

            case 'checkout.session.completed': {
                const session = event.data.object;
                const email   = session.customer_details?.email;
                if (!email) break;

                const key     = generateKey();
                const license = {
                    email,
                    key,
                    stripeCustomerId:      session.customer,
                    stripeSubscriptionId:  session.subscription,
                    plan:   'pro',
                    status: 'active',
                    createdAt: new Date().toISOString()
                };

                await redis.set(`license:${key}`, license);
                await redis.set(`customer:${session.customer}`, { key, email });
                // Store session → key for the success page (expire after 2 hours)
                await redis.set(`session:${session.id}`, key, { ex: 7200 });
                console.log(`New Pro subscription: ${email} → ${key}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub          = event.data.object;
                const customerData = await redis.get(`customer:${sub.customer}`);
                if (customerData?.key) {
                    const license = await redis.get(`license:${customerData.key}`);
                    if (license) {
                        await redis.set(`license:${customerData.key}`, { ...license, status: 'cancelled' });
                    }
                }
                break;
            }

            case 'invoice.payment_failed': {
                const invoice      = event.data.object;
                const customerData = await redis.get(`customer:${invoice.customer}`);
                if (customerData?.key) {
                    const license = await redis.get(`license:${customerData.key}`);
                    if (license) {
                        await redis.set(`license:${customerData.key}`, { ...license, status: 'past_due' });
                    }
                }
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice      = event.data.object;
                const customerData = await redis.get(`customer:${invoice.customer}`);
                if (customerData?.key) {
                    const license = await redis.get(`license:${customerData.key}`);
                    if (license) {
                        await redis.set(`license:${customerData.key}`, { ...license, status: 'active' });
                    }
                }
                break;
            }
        }
    } catch (err) {
        console.error('Webhook handler error:', err);
        // Still return 200 so Stripe doesn't retry
    }

    res.json({ received: true });
}
