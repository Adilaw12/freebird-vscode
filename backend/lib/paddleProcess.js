// backend/lib/paddleProcess.js — what a verified Paddle event does to licences.
//
// Split from api/paddle-webhook.js (which only does HTTP, signature, dedupe and
// locking) so the whole flow can be tested against an in-memory Redis. Redis,
// the email lookup and the clock come in through `deps`.
//
// Licence identity, in order: the Paddle customer already seen -> the GitHub
// account named by a verified link token -> a brand-new licence. The GitHub id
// is only ever taken from a link token we signed, never from plain custom data.

import { generateKey } from './keygen.js';
import { verifyLinkToken } from './linkToken.js';
import { githubLicenseKey } from './licenseResolve.js';
import { applySubscriptionEvent, deriveLicense, planForPriceId, pricesFromEnv } from './paddleLicense.js';

const TEAM_SEATS = 5;

function firstPriceId(data) {
    const item = data?.items?.[0];
    return item?.price?.id ?? item?.price_id ?? null;
}

/**
 * @param {object} event  parsed Paddle webhook body
 * @param {{ redis: any, fetchEmail?: (customerId: string) => Promise<string|null>,
 *           now?: () => string, prices?: object, countDaily?: (name: string) => Promise<void> }} deps
 * @returns {Promise<{ outcome: string, key?: string }>}
 */
export async function processPaddleEvent(event, deps) {
    const { redis } = deps;
    const now = deps.now ?? (() => new Date().toISOString());
    const prices = deps.prices ?? pricesFromEnv();
    const countDaily = deps.countDaily ?? (async () => {});
    const type = event.event_type;
    const data = event.data ?? {};

    const isSub = typeof type === 'string' && type.startsWith('subscription.');
    const isTxn = type === 'transaction.completed' || type === 'transaction.payment_failed';
    if (!isSub && !isTxn) return { outcome: 'ignored' };

    const customerId = data.customer_id;
    const subscriptionId = isSub ? data.id : data.subscription_id;
    if (!customerId) return { outcome: 'no_customer' };
    if (!subscriptionId) return { outcome: 'not_a_subscription' }; // one-off or manual invoice: nothing to license

    const paddleStatus = type === 'transaction.completed' ? 'active'
        : type === 'transaction.payment_failed' ? 'past_due'
        : data.status;

    const priceId = firstPriceId(data);
    const planInfo = planForPriceId(priceId, prices);

    // GitHub id from a token we signed (checkout custom data)
    const link = verifyLinkToken(data.custom_data?.linkToken);
    const githubId = link?.sub ?? null;

    // ── find the licence ──────────────────────────────────────────────────────
    const customerRec = await redis.get(`paddle:customer:${customerId}`);
    let key = customerRec?.key ?? null;
    if (!key && githubId) {
        const linked = await redis.get(githubLicenseKey(githubId));
        if (typeof linked === 'string' && linked) key = linked.toUpperCase();
    }

    let license = key ? await redis.get(`license:${key}`) : null;
    const existingSub = license?.paddleSubscriptions?.[subscriptionId];

    if (!license) {
        // Nothing to update, and nothing worth creating for a cancel or an unknown product.
        if (!planInfo) {
            console.error(`Paddle ${type}: unrecognised price ${priceId}; no licence granted`);
            await countDaily('unknown_price');
            return { outcome: 'unknown_price' };
        }
        if (paddleStatus === 'canceled' || paddleStatus === 'paused') return { outcome: 'ignored_inactive' };
        key = generateKey();
        const stamp = now();
        license = { key, provider: 'paddle', email: null, createdAt: stamp, updatedAt: stamp };
    }

    const { subs, applied } = applySubscriptionEvent(license.paddleSubscriptions ?? {}, {
        subscriptionId,
        plan: planInfo?.plan,
        cycle: planInfo?.cycle,
        paddleStatus,
        occurredAt: event.occurred_at,
        now: now(),
        manage: data.management_urls
            ? { update: data.management_urls.update_payment_method ?? null, cancel: data.management_urls.cancel ?? null }
            : undefined
    });
    if (!applied) return { outcome: 'stale_or_unknown', key };

    const derived = deriveLicense(subs);
    const previousStatus = license.status;

    // A licence that is still paid through Stripe is not downgraded by a Paddle cancellation.
    const keepStripeState = derived.status === 'cancelled' && license.stripeCustomerId && license.status === 'active';

    let email = license.email ?? null;
    if (!email && deps.fetchEmail) {
        try { email = await deps.fetchEmail(customerId); } catch { email = null; } // best effort
    }

    const stamp = now();
    const updated = {
        ...license,
        email,
        paddleCustomerId: customerId,
        paddleSubscriptions: subs,
        ...(keepStripeState ? {} : {
            plan: derived.plan,
            status: derived.status,
            pastDueSince: derived.pastDueSince,
            billingCycle: derived.billingCycle
        }),
        templateLibrary: derived.templateLibrary || license.templateLibrary === true && keepStripeState,
        ...(derived.plan === 'team' && !license.teamOwnerKey ? { teamOwnerKey: key } : {}),
        updatedAt: stamp
    };
    if (!updated.templateLibrary) delete updated.templateLibrary;
    if (updated.pastDueSince == null) delete updated.pastDueSince;

    // ── GitHub link ───────────────────────────────────────────────────────────
    if (githubId) {
        const current = await redis.get(githubLicenseKey(githubId));
        if (!current || String(current).toUpperCase() === key) {
            updated.githubId = String(githubId);
            if (link.login) updated.githubLogin = link.login;
            await redis.set(githubLicenseKey(githubId), key);
        } else {
            console.error(`Paddle: GitHub id ${githubId} is already linked to another licence; purchase ${key} left unlinked`);
            await countDaily('github_link_conflict');
        }
    }

    await redis.set(`license:${key}`, updated);
    await redis.set(`paddle:customer:${customerId}`, { key, email, createdAt: customerRec?.createdAt ?? stamp });

    // ── Team seats ────────────────────────────────────────────────────────────
    if (updated.teamOwnerKey === key && derived.plan === 'team') {
        await syncTeam(redis, key, updated, derived.status === 'cancelled' ? 'cancelled' : 'active', stamp);
    }

    // ── success page + counters ──────────────────────────────────────────────
    if (type === 'transaction.completed' && data.id) {
        await redis.set(`session:${data.id}`, key, { ex: 7200 });
    }
    if (!existingSub && derived.status === 'active') {
        await countDaily(derived.plan === 'templates' ? 'templates_subscribed' : 'pro_subscribed');
    } else if (type === 'transaction.completed' && data.origin === 'subscription_recurring') {
        await countDaily('subscription_renewed');
    } else if (type === 'transaction.payment_failed') {
        await countDaily('payment_failed');
    }
    if (derived.status === 'cancelled' && previousStatus !== 'cancelled' && !keepStripeState) {
        await countDaily('subscription_cancelled');
    }

    return { outcome: 'applied', key };
}

// Owner's seat record (created once), and seat licences follow the owner's subscription.
async function syncTeam(redis, ownerKey, ownerLicense, seatStatus, stamp) {
    let team = await redis.get(`team:${ownerKey}`);
    if (!team) {
        team = { ownerKey, ownerEmail: ownerLicense.email ?? null, maxSeats: TEAM_SEATS, seatKeys: [ownerKey], createdAt: stamp };
        await redis.set(`team:${ownerKey}`, team);
    }
    for (const seatKey of team.seatKeys ?? []) {
        if (seatKey === ownerKey) continue;
        const seat = await redis.get(`license:${seatKey}`);
        // 'revoked' seats were removed by the owner on purpose and stay removed.
        if (seat && (seat.status === 'active' || seat.status === 'cancelled') && seat.status !== seatStatus) {
            await redis.set(`license:${seatKey}`, { ...seat, status: seatStatus, updatedAt: stamp });
        }
    }
}
