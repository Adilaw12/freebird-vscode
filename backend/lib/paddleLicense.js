// backend/lib/paddleLicense.js — pure rules for turning Paddle subscriptions into
// a Freebird licence. No Redis, no network, so every rule here is unit-tested.
//
// A licence keeps one record per Paddle subscription (`paddleSubscriptions`).
// plan / status / templateLibrary are DERIVED from those records, so a customer
// with several subscriptions (say Templates first, Pro later) never gets one
// overwritten by the other, and events that arrive late or twice are harmless.

import { isLicenseActive } from './license.js';

export const PLAN_RANK = { templates: 1, pro: 2, team: 3 };

// checkout plan names (what the extension and the upgrade page use)
export const CHECKOUT_PLANS = ['pro', 'pro-annual', 'templates', 'team'];

/** Paddle subscription status -> licence status. null = unknown, leave alone. */
export function licenseStatusForPaddle(paddleStatus) {
    switch (paddleStatus) {
        case 'active':
        case 'trialing':
            return 'active';
        case 'past_due':
            return 'past_due';
        case 'canceled':
        case 'paused':
            return 'cancelled';
        default:
            return null;
    }
}

/** Price ids come from env, never from anything the client sends. */
export function pricesFromEnv(env = process.env) {
    return {
        'pro':        env.PADDLE_PRICE_PRO_MONTHLY,
        'pro-annual': env.PADDLE_PRICE_PRO_ANNUAL,
        'templates':  env.PADDLE_PRICE_TEMPLATES,
        'team':       env.PADDLE_PRICE_TEAM
    };
}

/** @returns {{ plan: 'pro'|'templates'|'team', cycle: 'monthly'|'annual' } | null} */
export function planForPriceId(priceId, prices = pricesFromEnv()) {
    if (!priceId) return null;
    for (const [checkoutPlan, id] of Object.entries(prices)) {
        if (id && id === priceId) {
            return checkoutPlan === 'pro-annual'
                ? { plan: 'pro', cycle: 'annual' }
                : { plan: checkoutPlan, cycle: 'monthly' };
        }
    }
    return null;
}

/**
 * Applies one Paddle event to the subscriptions map. Returns a new map.
 * Ignores events older than the last one applied to that subscription, so a
 * retried or out-of-order delivery can't undo newer state.
 *
 * @param {Record<string, object>} subs
 * @param {{ subscriptionId: string, plan?: string, cycle?: string, paddleStatus: string,
 *           occurredAt?: string, now?: string, manage?: object }} ev
 * @returns {{ subs: Record<string, object>, applied: boolean }}
 */
export function applySubscriptionEvent(subs, ev) {
    const current = subs?.[ev.subscriptionId];
    const status = licenseStatusForPaddle(ev.paddleStatus);
    if (!ev.subscriptionId || !status) return { subs: subs ?? {}, applied: false };

    const plan = ev.plan ?? current?.plan;
    if (!plan) return { subs: subs ?? {}, applied: false }; // can't tell what was bought

    const evTime = ev.occurredAt ? Date.parse(ev.occurredAt) : NaN;
    const lastTime = current?.occurredAt ? Date.parse(current.occurredAt) : NaN;
    if (Number.isFinite(evTime) && Number.isFinite(lastTime) && evTime < lastTime) {
        return { subs: subs ?? {}, applied: false };
    }

    const now = ev.now ?? new Date().toISOString();
    const next = {
        plan,
        cycle: ev.cycle ?? current?.cycle ?? 'monthly',
        status,
        pastDueSince: status === 'past_due' ? (current?.pastDueSince ?? now) : null,
        occurredAt: ev.occurredAt ?? current?.occurredAt ?? now,
        ...(ev.manage || current?.manage ? { manage: ev.manage ?? current.manage } : {})
    };
    return { subs: { ...(subs ?? {}), [ev.subscriptionId]: next }, applied: true };
}

const best = list => list.reduce((a, b) => (PLAN_RANK[b.plan] > PLAN_RANK[a.plan] ? b : a));

/** plan / status / flags for the licence record, from its subscriptions. */
export function deriveLicense(subs) {
    const entries = Object.values(subs ?? {});
    if (entries.length === 0) return null;

    const active = entries.filter(e => e.status === 'active');
    const pastDue = entries.filter(e => e.status === 'past_due');
    const hasTemplates = entries.some(e => e.plan === 'templates' && e.status !== 'cancelled');

    let top; let status;
    if (active.length) { top = best(active); status = 'active'; }
    else if (pastDue.length) { top = best(pastDue); status = 'past_due'; }
    else { top = best(entries); status = 'cancelled'; }

    return {
        plan: top.plan,
        status,
        pastDueSince: status === 'past_due' ? (top.pastDueSince ?? null) : null,
        billingCycle: top.cycle ?? 'monthly',
        // Pro/Team already bundle templates (lib/license.js); this flag matters
        // for a standalone templates subscription, which isLicenseActive() ignores.
        templateLibrary: hasTemplates
    };
}

/**
 * Should this account be stopped from buying `checkoutPlan`? Returns a stable
 * code and message, or null if the purchase is fine. Stops the double purchase
 * (Templates while on Pro/Team, a second Pro, Pro on top of Team).
 */
export function purchaseBlockReason(license, checkoutPlan) {
    if (!license) return null;
    const holdsPaid = isLicenseActive(license) && ['pro', 'team', 'enterprise'].includes(license.plan);
    const wanted = checkoutPlan === 'pro-annual' ? 'pro' : checkoutPlan;

    if (wanted === 'templates') {
        if (holdsPaid) return { code: 'INCLUDED_IN_PLAN', message: 'Your plan already includes Premium Prompt Templates.' };
        if (license.templateLibrary === true && license.status === 'active') {
            return { code: 'ALREADY_SUBSCRIBED', message: 'You already have Premium Prompt Templates.' };
        }
        return null;
    }
    if (holdsPaid) {
        const same = license.plan === wanted;
        return {
            code: same ? 'ALREADY_SUBSCRIBED' : 'CHANGE_PLAN',
            message: same
                ? `You already have an active Freebird ${wanted === 'team' ? 'Team' : 'Pro'} plan.`
                : 'You already have an active paid plan. To switch plans, email support@ten-labs.com.au so you are not charged twice.'
        };
    }
    return null;
}
