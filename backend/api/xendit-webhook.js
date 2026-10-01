// backend/api/xendit-webhook.js — receives Xendit's Payment Method (e-wallet
// tokenization) / Payment Request lifecycle events and mirrors backend/api/
// webhook.js's Redis write pattern so validate.js/success.js/license.js need
// zero changes for a Xendit-issued license.
//
// Auth: Xendit signs webhooks with a static X-CALLBACK-TOKEN header (shared
// secret from the dashboard), not an HMAC over the raw body like Stripe —
// no need to disable Next/Vercel's default body parsing here.
//
// VERIFY BEFORE PRODUCTION USE: Xendit's own docs mix two API/webhook
// generations — an older "Payment Token" one (event names like
// payment_token.activation, field payment_token_id) and the current
// "Payment Method" one this integration's code (lib/xenditClient.js) is
// built against, using the actually-installed xendit-node@7.0.0 SDK
// (PaymentMethodApi, field paymentMethodId). Event names below
// (payment_method.activated/.expired) match the SDK generation, but this
// has NOT been confirmed against a real webhook payload — use Xendit
// dashboard's "Test Webhook" sender (sandbox mode) to confirm the exact
// event names and field names your account actually sends, per the plan's
// verification section, before relying on this in production. The field
// reads below check multiple plausible key names defensively so a naming
// mismatch degrades to a logged error rather than silently misbehaving.

import { Redis } from '@upstash/redis';
import { timingSafeEqual } from 'crypto';
import { createPaymentRequest } from '../lib/xenditClient.js';
import { XENDIT_PLANS } from '../lib/xenditPricing.js';

const redis = Redis.fromEnv();

// Retry schedule for a failed recurring/first charge, in days from the
// ORIGINAL due date — mirrors the past_due -> cancelled semantics
// lib/license.js already relies on for the Stripe path.
const RETRY_OFFSETS_DAYS = [3, 7, 14];
const MAX_RETRIES = RETRY_OFFSETS_DAYS.length;

// Accept either generation's event name so a naming-convention surprise
// doesn't silently drop every webhook — see file header.
const ACTIVATED_EVENTS = new Set(['payment_method.activated', 'payment_token.activation']);
const EXPIRED_EVENTS = new Set(['payment_method.expired', 'payment_token.expiry', 'payment_method.failed', 'payment_token.failure']);
const CHARGE_SUCCEEDED_EVENTS = new Set(['payment_request.succeeded', 'payment.succeeded']);
const CHARGE_FAILED_EVENTS = new Set(['payment_request.failed', 'payment.failed']);

function fieldReferenceId(data) {
    return data.reference_id ?? data.referenceId;
}
function fieldMethodId(data) {
    return data.id ?? data.payment_method_id ?? data.payment_token_id ?? data.paymentMethodId;
}
function fieldCustomerId(data) {
    return data.customer_id ?? data.customerId;
}

function isAuthorized(req) {
    const expected = process.env.XENDIT_WEBHOOK_TOKEN || '';
    const provided = req.headers['x-callback-token'] || '';
    if (!expected) return false; // fail closed if unset, same posture as validate.js
    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

async function bumpFunnelTelemetry(country) {
    const today = new Date().toISOString().slice(0, 10);
    const paidKey = `telemetry:daily:${today}`;
    await redis.hincrby(paidKey, 'pro_subscribed', 1).catch(() => {});
    await redis.expire(paidKey, 90 * 24 * 60 * 60).catch(() => {});

    if (country) {
        const countryFunnelKey = `telemetry:countryFunnel:${today}`;
        await redis.hincrby(countryFunnelKey, `${country}:pro_subscribed`, 1).catch(() => {});
        await redis.expire(countryFunnelKey, 90 * 24 * 60 * 60).catch(() => {});
    }
}

async function scheduleNextCharge(key, dueAtMs) {
    await redis.zadd('xendit:duequeue', { score: dueAtMs, member: key });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });

    const event = req.body?.event;
    const data = req.body?.data ?? {};

    try {
        if (ACTIVATED_EVENTS.has(event)) {
            const referenceId = fieldReferenceId(data);
            const paymentMethodId = fieldMethodId(data);
            if (!referenceId || !paymentMethodId) {
                console.error(`${event}: missing reference_id/id in payload`, JSON.stringify(data).slice(0, 300));
            } else {
                const pending = await redis.get(`pending:xendit:${referenceId}`);
                if (!pending) {
                    console.error(`${event}: no pending record for`, referenceId);
                } else {
                    const plan = XENDIT_PLANS[pending.country];
                    if (plan) {
                        // First charge — a separate, backend-driven call. Its
                        // outcome arrives as its own succeeded/failed event below;
                        // nothing else to do here but trigger it.
                        await createPaymentRequest({
                            referenceId,
                            paymentMethodId,
                            amount: plan.amount,
                            currency: plan.currency,
                        });
                        await redis.set(`pending:xendit:${referenceId}`, { ...pending, xenditPaymentMethodId: paymentMethodId }, { ex: 3600 });
                    }
                }
            }
        }

        else if (CHARGE_SUCCEEDED_EVENTS.has(event)) {
            const key = fieldReferenceId(data);
            if (key) {
                const existing = await redis.get(`license:${key}`);
                const nextChargeDueAt = new Date();
                nextChargeDueAt.setMonth(nextChargeDueAt.getMonth() + 1);

                if (existing) {
                    // Recurring renewal charge.
                    await redis.set(`license:${key}`, {
                        ...existing,
                        status: 'active',
                        chargeRetryCount: 0,
                        nextChargeDueAt: nextChargeDueAt.toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    await scheduleNextCharge(key, nextChargeDueAt.getTime());
                    console.log(`Xendit subscription renewed: ${key}`);
                } else {
                    // First charge — promote the pending checkout into a real license.
                    const pending = await redis.get(`pending:xendit:${key}`);
                    if (!pending) {
                        console.error('payment succeeded: no pending or existing license for', key);
                    } else {
                        const now = new Date().toISOString();
                        const customerId = fieldCustomerId(data) ?? `xendit:${key}`;
                        const license = {
                            email: pending.email,
                            key,
                            provider: 'xendit',
                            xenditCustomerId: customerId,
                            xenditPaymentMethodId: pending.xenditPaymentMethodId ?? fieldMethodId(data),
                            country: pending.country,
                            currency: pending.currency,
                            plan: 'pro',
                            status: 'active',
                            chargeRetryCount: 0,
                            nextChargeDueAt: nextChargeDueAt.toISOString(),
                            createdAt: now,
                            updatedAt: now,
                        };

                        await redis.set(`license:${key}`, license);
                        await redis.set(`customer:${customerId}`, { key, email: license.email, createdAt: now });
                        await redis.set(`session:${key}`, key, { ex: 7200 }); // session_id === key here, success.js doesn't care
                        await redis.del(`pending:xendit:${key}`);
                        await scheduleNextCharge(key, nextChargeDueAt.getTime());
                        await bumpFunnelTelemetry(pending.country);

                        console.log(`Freebird pro activated via Xendit: ${license.email} → ${key}`);
                    }
                }
            }
        }

        else if (CHARGE_FAILED_EVENTS.has(event)) {
            const key = fieldReferenceId(data);
            if (key) {
                const license = await redis.get(`license:${key}`);
                if (!license) {
                    // First-charge failure — never became a real license, nothing to dunning.
                    await redis.del(`pending:xendit:${key}`);
                } else {
                    const retryCount = (license.chargeRetryCount ?? 0) + 1;
                    if (retryCount > MAX_RETRIES) {
                        await redis.set(`license:${key}`, {
                            ...license,
                            status: 'cancelled',
                            updatedAt: new Date().toISOString(),
                        });
                        console.log(`Xendit subscription cancelled after ${MAX_RETRIES} failed retries: ${key}`);
                    } else {
                        const retryAt = new Date();
                        retryAt.setDate(retryAt.getDate() + RETRY_OFFSETS_DAYS[retryCount - 1]);
                        await redis.set(`license:${key}`, {
                            ...license,
                            status: 'past_due',
                            chargeRetryCount: retryCount,
                            nextChargeDueAt: retryAt.toISOString(),
                            updatedAt: new Date().toISOString(),
                        });
                        await scheduleNextCharge(key, retryAt.getTime());
                        console.log(`Xendit charge failed (attempt ${retryCount}/${MAX_RETRIES}): ${key}, retrying ${retryAt.toISOString()}`);
                    }
                }
            }
        }

        else if (EXPIRED_EVENTS.has(event)) {
            const referenceId = fieldReferenceId(data);
            if (referenceId) await redis.del(`pending:xendit:${referenceId}`);
        }
        // Unhandled event type — safe to ignore.

    } catch (err) {
        console.error(`Xendit webhook handler error for ${event}:`, err);
        // Return 200 below so Xendit doesn't retry over our own bugs — log for manual review.
    }

    return res.status(200).json({ received: true });
}
