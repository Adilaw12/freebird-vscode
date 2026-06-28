import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { generateKey } from '../lib/keygen.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const redis  = Redis.fromEnv();

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
                if (!email) {
                    console.error('checkout.session.completed: no email found', session.id);
                    break;
                }

                // Check if this customer already has a key (e.g. resubscribed)
                const existingCustomer = await redis.get(`customer:${session.customer}`);
                let key = existingCustomer?.key;

                if (!key) {
                    // Brand new subscriber — generate a fresh key
                    key = generateKey();
                }

                const license = {
                    email,
                    key,
                    stripeCustomerId:     session.customer,
                    stripeSubscriptionId: session.subscription,
                    plan:      'pro',
                    status:    'active',
                    createdAt: existingCustomer?.createdAt ?? new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                await redis.set(`license:${key}`, license);
                await redis.set(`customer:${session.customer}`, { key, email, createdAt: license.createdAt });
                // Store session → key for the success page (expires after 2 hours)
                await redis.set(`session:${session.id}`, key, { ex: 7200 });

                // Funnel stage 3: a checkout completed — the bottom of the
                // conversion funnel. Recorded in the same daily telemetry hash
                // as quota_wall_shown / upgrade_clicked so the dashboard can
                // compute wall → click → paid conversion rates.
                const paidKey = `telemetry:daily:${new Date().toISOString().slice(0, 10)}`;
                await redis.hincrby(paidKey, 'pro_subscribed', 1).catch(() => {});
                await redis.expire(paidKey, 90 * 24 * 60 * 60).catch(() => {});

                console.log(`Freebird Pro activated: ${email} → ${key}`);
                break;
            }

            case 'customer.subscription.updated': {
                // Handles plan changes, trial endings, reactivations
                const sub          = event.data.object;
                const customerData = await redis.get(`customer:${sub.customer}`);
                if (!customerData?.key) break;

                const license = await redis.get(`license:${customerData.key}`);
                if (!license) break;

                const newStatus = sub.status === 'active' ? 'active' : sub.status;
                await redis.set(`license:${customerData.key}`, {
                    ...license,
                    status:    newStatus,
                    updatedAt: new Date().toISOString()
                });
                console.log(`Subscription updated for ${license.email}: ${newStatus}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub          = event.data.object;
                const customerData = await redis.get(`customer:${sub.customer}`);
                if (!customerData?.key) break;

                const license = await redis.get(`license:${customerData.key}`);
                if (!license) break;

                await redis.set(`license:${customerData.key}`, {
                    ...license,
                    status:    'cancelled',
                    updatedAt: new Date().toISOString()
                });
                console.log(`Subscription cancelled for ${license.email}`);
                break;
            }

            case 'invoice.payment_failed': {
                const invoice      = event.data.object;
                const customerData = await redis.get(`customer:${invoice.customer}`);
                if (!customerData?.key) break;

                const license = await redis.get(`license:${customerData.key}`);
                if (!license) break;

                await redis.set(`license:${customerData.key}`, {
                    ...license,
                    status:    'past_due',
                    updatedAt: new Date().toISOString()
                });
                console.log(`Payment failed for ${license.email}`);
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice      = event.data.object;
                // Skip the first invoice — handled by checkout.session.completed
                if (invoice.billing_reason === 'subscription_create') break;

                const customerData = await redis.get(`customer:${invoice.customer}`);
                if (!customerData?.key) break;

                const license = await redis.get(`license:${customerData.key}`);
                if (!license) break;

                await redis.set(`license:${customerData.key}`, {
                    ...license,
                    status:    'active',
                    updatedAt: new Date().toISOString()
                });
                console.log(`Subscription renewed for ${license.email}`);
                break;
            }

            default:
                // Unhandled event type — safe to ignore
                break;
        }
    } catch (err) {
        console.error(`Webhook handler error for ${event.type}:`, err);
        // Return 200 so Stripe doesn't retry — log the error for manual review
    }

    res.json({ received: true });
}
