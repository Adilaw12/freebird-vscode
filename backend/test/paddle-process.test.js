// test/paddle-process.test.js — Paddle events against an in-memory Redis.

process.env.AUTH_SECRET = 'test-secret-for-paddle-process';

const { processPaddleEvent } = await import('../lib/paddleProcess.js');
const { signLinkToken } = await import('../lib/linkToken.js');
const { isLicenseActive, hasTemplateLibraryAccess } = await import('../lib/license.js');

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

function makeRedis() {
    const m = new Map();
    return {
        m,
        get: async k => (m.has(k) ? structuredClone(m.get(k)) : null),
        set: async (k, v, o = {}) => { if (o.nx && m.has(k)) return null; m.set(k, structuredClone(v)); return 'OK'; },
        del: async k => { m.delete(k); }
    };
}

const prices = { 'pro': 'pri_pm', 'pro-annual': 'pri_pa', 'templates': 'pri_t', 'team': 'pri_team' };
let clock = 0;
const mk = () => {
    const counts = {};
    return {
        redis: makeRedis(), counts,
        deps(extra = {}) {
            return {
                redis: this.redis, prices,
                now: () => new Date(Date.UTC(2026, 10, 9, 1, 0, clock++)).toISOString(),
                fetchEmail: async () => 'buyer@example.com',
                countDaily: async n => { counts[n] = (counts[n] ?? 0) + 1; },
                ...extra
            };
        }
    };
};
let n = 0;
const at = i => new Date(Date.UTC(2026, 10, 9, 1, 0, i)).toISOString();
const ev = (event_type, data, i) => ({ event_id: `evt_${++n}`, event_type, occurred_at: at(i), data });
const link = (id, login = 'dev') => ({ linkToken: signLinkToken({ githubId: id, login, plan: 'pro' }) });

console.log('\n--- first purchase ---');
{
    const w = mk(); const d = w.deps();
    const txn = ev('transaction.completed', { id: 'txn_1', customer_id: 'ctm_1', subscription_id: 'sub_1', origin: 'web', items: [{ price: { id: 'pri_pa' } }], custom_data: link(555, 'adisa') }, 10);
    const r = await processPaddleEvent(txn, d);
    const key = r.key;
    const lic = await w.redis.get(`license:${key}`);
    check('outcome applied, key generated', r.outcome === 'applied' && /^FB-/.test(key));
    check('licence is saved (validate.js can find it)', lic && lic.plan === 'pro' && lic.status === 'active');
    check('licence is active by the app\'s own rule', isLicenseActive(lic));
    check('annual cycle recorded', lic.billingCycle === 'annual');
    check('email fetched from Paddle', lic.email === 'buyer@example.com');
    check('linked to the GitHub account', lic.githubId === '555' && lic.githubLogin === 'adisa' && (await w.redis.get('ghlicense:555')) === key);
    check('customer mapping saved', (await w.redis.get('paddle:customer:ctm_1')).key === key);
    check('success page can find the key by transaction id', (await w.redis.get('session:txn_1')) === key);
    check('counted once as subscribed', w.counts.pro_subscribed === 1);

    // subscription.created arrives AFTER the transaction (out of order) and then again
    const created = ev('subscription.created', { id: 'sub_1', status: 'active', customer_id: 'ctm_1', items: [{ price: { id: 'pri_pa' } }], custom_data: link(555), management_urls: { update_payment_method: 'https://u', cancel: 'https://c' } }, 11);
    await processPaddleEvent(created, d);
    await processPaddleEvent(created, d);
    const lic2 = await w.redis.get(`license:${key}`);
    check('late subscription.created does not make a second licence', [...w.redis.m.keys()].filter(k => k.startsWith('license:')).length === 1);
    check('manage links stored', lic2.paddleSubscriptions.sub_1.manage.cancel === 'https://c');
    check('not double counted as subscribed', w.counts.pro_subscribed === 1);
}

console.log('\n--- identity ---');
{
    const w = mk(); const d = w.deps();
    const r = await processPaddleEvent(ev('transaction.completed', { id: 'txn_2', customer_id: 'ctm_2', subscription_id: 'sub_2', items: [{ price: { id: 'pri_pm' } }], custom_data: { githubId: '999' } }, 10), d);
    const lic = await w.redis.get(`license:${r.key}`);
    check('a plain (unsigned) githubId in custom data is ignored', !lic.githubId && (await w.redis.get('ghlicense:999')) === null);
    const forged = ev('transaction.completed', { id: 'txn_3', customer_id: 'ctm_3', subscription_id: 'sub_3', items: [{ price: { id: 'pri_pm' } }], custom_data: { linkToken: 'AAAA.BBBB' } }, 11);
    const r3 = await processPaddleEvent(forged, d);
    check('a forged link token is ignored but the purchase still gets a licence', r3.outcome === 'applied' && !(await w.redis.get(`license:${r3.key}`)).githubId);
}
{
    // a GitHub account with an existing (Stripe) licence buys on Paddle: attaches to it, no second licence
    const w = mk(); const d = w.deps();
    await w.redis.set('license:FB-STRP-STRP-STRP-STRP', { key: 'FB-STRP-STRP-STRP-STRP', plan: 'pro', status: 'active', stripeCustomerId: 'cus_x', email: 'old@example.com', githubId: '42' });
    await w.redis.set('ghlicense:42', 'FB-STRP-STRP-STRP-STRP');
    const r = await processPaddleEvent(ev('transaction.completed', { id: 'txn_s', customer_id: 'ctm_s', subscription_id: 'sub_s', items: [{ price: { id: 'pri_pm' } }], custom_data: link(42) }, 10), d);
    check('attached to the account\'s existing licence', r.key === 'FB-STRP-STRP-STRP-STRP' && [...w.redis.m.keys()].filter(k => k.startsWith('license:')).length === 1);
    check('existing email kept', (await w.redis.get('license:FB-STRP-STRP-STRP-STRP')).email === 'old@example.com');
    // Paddle sub cancels while Stripe is still paying: not downgraded
    await processPaddleEvent(ev('subscription.canceled', { id: 'sub_s', status: 'canceled', customer_id: 'ctm_s', items: [{ price: { id: 'pri_pm' } }] }, 20), d);
    const after = await w.redis.get('license:FB-STRP-STRP-STRP-STRP');
    check('a Paddle cancellation does not cut off a licence still paid via Stripe', after.status === 'active');
}
{
    // second GitHub account claims a customer already linked elsewhere: purchase stays, conflict counted
    const w = mk(); const d = w.deps();
    await w.redis.set('ghlicense:7', 'FB-OTHR-OTHR-OTHR-OTHR');
    await w.redis.set('license:FB-OTHR-OTHR-OTHR-OTHR', { key: 'FB-OTHR-OTHR-OTHR-OTHR', plan: 'pro', status: 'cancelled' });
    // customer ctm_n is new and link names GitHub 7: finds 7's licence via ghlicense, so attaches there
    const r = await processPaddleEvent(ev('transaction.completed', { id: 'txn_n', customer_id: 'ctm_n', subscription_id: 'sub_n', items: [{ price: { id: 'pri_pm' } }], custom_data: link(7) }, 10), d);
    const l = await w.redis.get(`license:${r.key}`);
    check('re-buying after a cancel reactivates the account\'s own licence', r.key === 'FB-OTHR-OTHR-OTHR-OTHR' && l.status === 'active');
}

console.log('\n--- unknown / inactive ---');
{
    const w = mk(); const d = w.deps();
    const r = await processPaddleEvent(ev('transaction.completed', { id: 't', customer_id: 'ctm_u', subscription_id: 'sub_u', items: [{ price: { id: 'pri_mystery' } }] }, 10), d);
    check('unknown price grants nothing', r.outcome === 'unknown_price' && [...w.redis.m.keys()].length === 0);
    check('unknown price is counted', w.counts.unknown_price === 1);
    const c = await processPaddleEvent(ev('subscription.canceled', { id: 'sub_z', status: 'canceled', customer_id: 'ctm_z', items: [{ price: { id: 'pri_pm' } }] }, 10), d);
    check('a cancel for a customer we never licensed creates nothing', c.outcome === 'ignored_inactive' && [...w.redis.m.keys()].length === 0);
    check('unrelated events are ignored', (await processPaddleEvent(ev('customer.updated', { id: 'ctm' }, 1), d)).outcome === 'ignored');
    check('a one-off transaction (no subscription) is ignored', (await processPaddleEvent(ev('transaction.completed', { id: 'x', customer_id: 'c' }, 1), d)).outcome === 'not_a_subscription');
}

console.log('\n--- lifecycle ---');
{
    const w = mk(); const d = w.deps();
    const base = { customer_id: 'ctm_l', subscription_id: 'sub_l', items: [{ price: { id: 'pri_pm' } }] };
    const r = await processPaddleEvent(ev('transaction.completed', { ...base, id: 'txn_a', origin: 'web', custom_data: link(1) }, 10), d);
    const get = async () => w.redis.get(`license:${r.key}`);

    await processPaddleEvent(ev('transaction.payment_failed', { ...base, id: 'txn_b' }, 20), d);
    let l = await get();
    check('failed payment: past_due with a start time', l.status === 'past_due' && l.pastDueSince);
    check('still entitled during the grace period', isLicenseActive(l));
    check('payment_failed counted', w.counts.payment_failed === 1);

    await processPaddleEvent(ev('transaction.completed', { ...base, id: 'txn_c', origin: 'subscription_recurring' }, 30), d);
    l = await get();
    check('successful retry: active again, grace cleared', l.status === 'active' && !l.pastDueSince);
    check('renewal counted', w.counts.subscription_renewed === 1);

    // a stale past_due arriving late must not undo the recovery
    await processPaddleEvent(ev('subscription.updated', { id: 'sub_l', status: 'past_due', customer_id: 'ctm_l', items: base.items }, 25), d);
    check('a late, older event cannot undo newer state', (await get()).status === 'active');

    await processPaddleEvent(ev('subscription.canceled', { id: 'sub_l', status: 'canceled', customer_id: 'ctm_l', items: base.items }, 40), d);
    l = await get();
    check('cancel: licence cancelled and no longer entitled', l.status === 'cancelled' && !isLicenseActive(l));
    check('cancel counted once', w.counts.subscription_cancelled === 1);
    check('GitHub link survives a cancel (so a re-subscribe reattaches)', (await w.redis.get('ghlicense:1')) === r.key);
}

console.log('\n--- templates, pro, team ---');
{
    const w = mk(); const d = w.deps();
    const t = await processPaddleEvent(ev('transaction.completed', { id: 'tt', customer_id: 'ctm_t', subscription_id: 'sub_t', items: [{ price: { id: 'pri_t' } }], custom_data: link(2) }, 10), d);
    let l = await w.redis.get(`license:${t.key}`);
    check('templates: standalone plan with library access', l.plan === 'templates' && hasTemplateLibraryAccess(l));
    check('templates does NOT unlock Pro', !isLicenseActive(l));
    check('templates counted separately', w.counts.templates_subscribed === 1 && !w.counts.pro_subscribed);

    const p = await processPaddleEvent(ev('transaction.completed', { id: 'tp', customer_id: 'ctm_t', subscription_id: 'sub_p', items: [{ price: { id: 'pri_pm' } }], custom_data: link(2) }, 20), d);
    l = await w.redis.get(`license:${t.key}`);
    check('upgrading to Pro keeps one licence', p.key === t.key);
    check('now Pro, templates flag kept', l.plan === 'pro' && isLicenseActive(l) && l.templateLibrary === true);
    await processPaddleEvent(ev('subscription.canceled', { id: 'sub_p', status: 'canceled', customer_id: 'ctm_t', items: [{ price: { id: 'pri_pm' } }] }, 30), d);
    l = await w.redis.get(`license:${t.key}`);
    check('cancelling Pro leaves the templates subscription working', l.plan === 'templates' && l.status === 'active' && hasTemplateLibraryAccess(l) && !isLicenseActive(l));
}
{
    const w = mk(); const d = w.deps();
    const r = await processPaddleEvent(ev('transaction.completed', { id: 'tm', customer_id: 'ctm_team', subscription_id: 'sub_team', items: [{ price: { id: 'pri_team' } }], custom_data: link(3) }, 10), d);
    const owner = await w.redis.get(`license:${r.key}`);
    const team = await w.redis.get(`team:${r.key}`);
    check('team: owner licence points at itself', owner.plan === 'team' && owner.teamOwnerKey === r.key);
    check('team: 5-seat record with the owner in seat 1', team.maxSeats === 5 && team.seatKeys.length === 1 && team.seatKeys[0] === r.key);

    // owner adds two seats via team-seats.js (simulated), one later revoked
    await w.redis.set('license:FB-SEAT-AAAA-AAAA-AAAA', { plan: 'team', status: 'active', teamOwnerKey: r.key });
    await w.redis.set('license:FB-SEAT-BBBB-BBBB-BBBB', { plan: 'team', status: 'revoked', teamOwnerKey: r.key });
    await w.redis.set(`team:${r.key}`, { ...team, seatKeys: [r.key, 'FB-SEAT-AAAA-AAAA-AAAA', 'FB-SEAT-BBBB-BBBB-BBBB'] });

    await processPaddleEvent(ev('subscription.canceled', { id: 'sub_team', status: 'canceled', customer_id: 'ctm_team', items: [{ price: { id: 'pri_team' } }] }, 20), d);
    check('team cancel cascades to active seats', (await w.redis.get('license:FB-SEAT-AAAA-AAAA-AAAA')).status === 'cancelled');
    check('revoked seats stay revoked', (await w.redis.get('license:FB-SEAT-BBBB-BBBB-BBBB')).status === 'revoked');

    await processPaddleEvent(ev('subscription.activated', { id: 'sub_team', status: 'active', customer_id: 'ctm_team', items: [{ price: { id: 'pri_team' } }] }, 30), d);
    check('team re-subscribe restores seats', (await w.redis.get('license:FB-SEAT-AAAA-AAAA-AAAA')).status === 'active');
    check('revoked seats are still not restored', (await w.redis.get('license:FB-SEAT-BBBB-BBBB-BBBB')).status === 'revoked');
}

console.log('\n--- email lookup failure ---');
{
    const w = mk(); const d = w.deps({ fetchEmail: async () => { throw new Error('Paddle down'); } });
    const r = await processPaddleEvent(ev('transaction.completed', { id: 'te', customer_id: 'ctm_e', subscription_id: 'sub_e', items: [{ price: { id: 'pri_pm' } }] }, 10), d);
    check('a failed email lookup does not block the licence', r.outcome === 'applied' && (await w.redis.get(`license:${r.key}`)).email === null);
}

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
