// test/paddle-license.test.js — Paddle subscriptions to licence rules (pure functions).

import {
    licenseStatusForPaddle, planForPriceId, applySubscriptionEvent, deriveLicense, purchaseBlockReason
} from '../lib/paddleLicense.js';

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

console.log('\n--- Paddle status mapping ---');
check('active maps to active', licenseStatusForPaddle('active') === 'active');
check('trialing maps to active', licenseStatusForPaddle('trialing') === 'active');
check('past_due maps to past_due', licenseStatusForPaddle('past_due') === 'past_due');
check('canceled maps to cancelled', licenseStatusForPaddle('canceled') === 'cancelled');
check('paused maps to cancelled', licenseStatusForPaddle('paused') === 'cancelled');
check('an unknown status leaves the licence alone', licenseStatusForPaddle('something_new') === null);

console.log('\n--- price id to plan ---');
const prices = { 'pro': 'pri_pm', 'pro-annual': 'pri_pa', 'templates': 'pri_t', 'team': 'pri_team' };
check('pro monthly', JSON.stringify(planForPriceId('pri_pm', prices)) === '{"plan":"pro","cycle":"monthly"}');
check('pro annual is plan pro, annual cycle', JSON.stringify(planForPriceId('pri_pa', prices)) === '{"plan":"pro","cycle":"annual"}');
check('templates', planForPriceId('pri_t', prices).plan === 'templates');
check('team', planForPriceId('pri_team', prices).plan === 'team');
check('unknown price is null (never defaults to pro)', planForPriceId('pri_other', prices) === null);
check('missing price is null', planForPriceId(undefined, prices) === null);
check('unset env price never matches an undefined id', planForPriceId(undefined, { pro: undefined }) === null);

console.log('\n--- applying events ---');
const T1 = '2026-11-09T01:00:00Z', T2 = '2026-11-09T02:00:00Z', T3 = '2026-11-09T03:00:00Z';
let r = applySubscriptionEvent({}, { subscriptionId: 's1', plan: 'pro', cycle: 'annual', paddleStatus: 'active', occurredAt: T2, now: T2 });
check('first event is applied', r.applied && r.subs.s1.status === 'active' && r.subs.s1.cycle === 'annual');
const stale = applySubscriptionEvent(r.subs, { subscriptionId: 's1', plan: 'pro', paddleStatus: 'past_due', occurredAt: T1 });
check('an older event is ignored (out of order)', !stale.applied && stale.subs.s1.status === 'active');
const dup = applySubscriptionEvent(r.subs, { subscriptionId: 's1', plan: 'pro', paddleStatus: 'active', occurredAt: T2 });
check('the same event twice is harmless', dup.applied && dup.subs.s1.status === 'active');
const pd = applySubscriptionEvent(r.subs, { subscriptionId: 's1', paddleStatus: 'past_due', occurredAt: T3, now: T3 });
check('an event without a price keeps the known plan', pd.applied && pd.subs.s1.plan === 'pro' && pd.subs.s1.status === 'past_due');
check('past_due remembers when it started', pd.subs.s1.pastDueSince === T3);
const pd2 = applySubscriptionEvent(pd.subs, { subscriptionId: 's1', paddleStatus: 'past_due', occurredAt: '2026-11-09T04:00:00Z', now: '2026-11-09T04:00:00Z' });
check('a second past_due keeps the original start', pd2.subs.s1.pastDueSince === T3);
const back = applySubscriptionEvent(pd.subs, { subscriptionId: 's1', paddleStatus: 'active', occurredAt: '2026-11-09T05:00:00Z' });
check('recovery clears pastDueSince', back.subs.s1.status === 'active' && back.subs.s1.pastDueSince === null);
check('no plan known and none given is not applied', !applySubscriptionEvent({}, { subscriptionId: 'x', paddleStatus: 'active' }).applied);
check('an unknown status is not applied', !applySubscriptionEvent(r.subs, { subscriptionId: 's1', paddleStatus: 'weird', occurredAt: T3 }).applied);

console.log('\n--- deriving the licence ---');
const sub = (plan, status, extra = {}) => ({ plan, cycle: 'monthly', status, pastDueSince: null, occurredAt: T1, ...extra });
check('no subscriptions derives nothing', deriveLicense({}) === null);
let d = deriveLicense({ a: sub('pro', 'active') });
check('active pro', d.plan === 'pro' && d.status === 'active' && d.templateLibrary === false);
d = deriveLicense({ a: sub('templates', 'active') });
check('templates only: plan templates, templateLibrary true', d.plan === 'templates' && d.templateLibrary === true && d.status === 'active');
d = deriveLicense({ a: sub('templates', 'active'), b: sub('pro', 'active') });
check('templates + pro: the higher plan wins, templates flag kept', d.plan === 'pro' && d.templateLibrary === true);
d = deriveLicense({ a: sub('pro', 'active'), b: sub('team', 'active') });
check('pro + team: team wins', d.plan === 'team');
d = deriveLicense({ a: sub('pro', 'cancelled'), b: sub('templates', 'active') });
check('pro cancelled, templates still active: templates, active', d.plan === 'templates' && d.status === 'active');
d = deriveLicense({ a: sub('team', 'past_due', { pastDueSince: T2 }) });
check('past_due carries its start', d.status === 'past_due' && d.pastDueSince === T2);
d = deriveLicense({ a: sub('pro', 'past_due', { pastDueSince: T2 }), b: sub('templates', 'active') });
check('an active lower plan beats a past_due higher one', d.status === 'active' && d.plan === 'templates');
d = deriveLicense({ a: sub('pro', 'cancelled'), b: sub('team', 'cancelled') });
check('all cancelled: cancelled, remembers highest plan', d.status === 'cancelled' && d.plan === 'team' && d.templateLibrary === false);
d = deriveLicense({ a: sub('pro', 'cancelled', { cycle: 'annual' }) });
check('billing cycle follows the top subscription', d.billingCycle === 'annual');

console.log('\n--- double-purchase guard ---');
const lic = (plan, status = 'active', extra = {}) => ({ plan, status, ...extra });
check('no licence: anything can be bought', purchaseBlockReason(null, 'pro') === null && purchaseBlockReason(null, 'templates') === null);
check('trial can buy pro', purchaseBlockReason(lic('trial', 'active', { trialEndsAt: new Date(Date.now() + 1e9).toISOString() }), 'pro') === null);
check('free (cancelled) can buy pro again', purchaseBlockReason(lic('pro', 'cancelled'), 'pro') === null);
check('pro cannot buy templates (included)', purchaseBlockReason(lic('pro'), 'templates')?.code === 'INCLUDED_IN_PLAN');
check('team cannot buy templates (included)', purchaseBlockReason(lic('team'), 'templates')?.code === 'INCLUDED_IN_PLAN');
check('pro cannot buy pro again', purchaseBlockReason(lic('pro'), 'pro')?.code === 'ALREADY_SUBSCRIBED');
check('pro cannot buy annual on top', purchaseBlockReason(lic('pro'), 'pro-annual')?.code === 'ALREADY_SUBSCRIBED');
check('pro cannot buy team on top (switch via support)', purchaseBlockReason(lic('pro'), 'team')?.code === 'CHANGE_PLAN');
check('team cannot buy pro on top', purchaseBlockReason(lic('team'), 'pro')?.code === 'CHANGE_PLAN');
check('templates subscriber cannot buy templates again', purchaseBlockReason(lic('templates', 'active', { templateLibrary: true }), 'templates')?.code === 'ALREADY_SUBSCRIBED');
check('templates subscriber can upgrade to pro', purchaseBlockReason(lic('templates', 'active', { templateLibrary: true }), 'pro') === null);
check('pro in past_due grace still blocks a second purchase', purchaseBlockReason(lic('pro', 'past_due', { pastDueSince: new Date().toISOString() }), 'pro') !== null);

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
