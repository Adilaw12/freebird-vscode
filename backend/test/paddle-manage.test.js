// test/paddle-manage.test.js — management links fetched from Paddle and saved.
const { fetchManagementUrls, resolveManageLinks, paddleBase } = await import('../lib/paddleManage.js');

let total = 0, failed = 0;
const check = (l, c) => { total++; if (!c) failed++; console.log(`${c ? 'PASS' : 'FAIL'} — ${l}`); };
const makeRedis = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? structuredClone(m.get(k)) : null), set: async (k, v) => { m.set(k, structuredClone(v)); return 'OK'; } }; };
const lic = (subs, extra = {}) => ({ key: 'FB-AAAA-BBBB-CCCC-DDDD', plan: 'pro', paddleSubscriptions: subs, ...extra });
const ok = body => async () => ({ ok: true, json: async () => body });

check('sandbox base', paddleBase('sandbox') === 'https://sandbox-api.paddle.com');
check('production base', paddleBase('production') === 'https://api.paddle.com' && paddleBase(undefined) === 'https://api.paddle.com');

let seen;
const r1 = await fetchManagementUrls('sub_1', { apiKey: 'k', env: 'sandbox', fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ data: { management_urls: { update_payment_method: 'https://u', cancel: 'https://c' } } }) }; } });
check('parses management_urls', r1?.update === 'https://u' && r1?.cancel === 'https://c');
check('calls sandbox subscription endpoint with bearer', seen.u === 'https://sandbox-api.paddle.com/subscriptions/sub_1' && seen.o.headers.Authorization === 'Bearer k');
check('no api key -> null', (await fetchManagementUrls('sub_1', { apiKey: '', fetchImpl: ok({}) })) === null);
check('http error -> null', (await fetchManagementUrls('sub_1', { apiKey: 'k', fetchImpl: async () => ({ ok: false }) })) === null);
check('network error -> null', (await fetchManagementUrls('sub_1', { apiKey: 'k', fetchImpl: async () => { throw new Error('down'); } })) === null);
check('missing management_urls -> null', (await fetchManagementUrls('sub_1', { apiKey: 'k', fetchImpl: ok({ data: {} }) })) === null);

{
    const redis = makeRedis(); const l = lic({ sub_1: { plan: 'pro', status: 'active' } });
    await redis.set(`license:${l.key}`, l);
    let calls = 0; const fetchUrls = async id => { calls++; return { update: `u-${id}`, cancel: `c-${id}` }; };
    const m = await resolveManageLinks(l, { redis, fetchUrls });
    check('fetches when nothing saved', m.update === 'u-sub_1' && calls === 1);
    check('saves links on the licence', (await redis.get(`license:${l.key}`)).paddleSubscriptions.sub_1.manage.cancel === 'c-sub_1');
    const m2 = await resolveManageLinks(await redis.get(`license:${l.key}`), { redis, fetchUrls });
    check('uses the saved copy afterwards', m2.update === 'u-sub_1' && calls === 1);
}
{
    const l = lic({ sub_old: { plan: 'pro', status: 'cancelled' }, sub_t: { plan: 'templates', status: 'active' }, sub_p: { plan: 'pro', status: 'active' } });
    let asked; const m = await resolveManageLinks(l, { fetchUrls: async id => { asked = id; return { update: 'u', cancel: 'c' }; } });
    check('picks the active subscription that sets the plan', asked === 'sub_p' && m.update === 'u');
}
{
    const l = lic({ sub_old: { plan: 'pro', status: 'cancelled' } });
    check('only cancelled subscriptions -> null', (await resolveManageLinks(l, { fetchUrls: async () => ({ update: 'u' }) })) === null);
    check('no subscriptions -> null', (await resolveManageLinks(lic({}), { fetchUrls: async () => ({ update: 'u' }) })) === null);
    check('null licence -> null', (await resolveManageLinks(null, {})) === null);
}
{
    const l = lic({ sub_1: { plan: 'pro', status: 'active' } });
    check('Paddle failure -> null, nothing saved', (await resolveManageLinks(l, { redis: makeRedis(), fetchUrls: async () => null })) === null);
}
{
    const redis = makeRedis(); const l = lic({ sub_1: { plan: 'pro', status: 'active' } });
    await redis.set(`license:${l.key}`, { ...l, paddleSubscriptions: {} });
    const m = await resolveManageLinks(l, { redis, fetchUrls: async () => ({ update: 'u', cancel: 'c' }) });
    check('links still returned if the record changed meanwhile', m.update === 'u');
    check('and the changed record is not overwritten', Object.keys((await redis.get(`license:${l.key}`)).paddleSubscriptions).length === 0);
}
console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
