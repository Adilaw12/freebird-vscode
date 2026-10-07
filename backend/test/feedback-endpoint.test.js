// backend/test/feedback-endpoint.test.js — exercises the REAL api/feedback.js
// handler against a mocked Upstash wire protocol (same approach as
// templates-endpoint.test.js). Requires `npm install` inside backend/ first.
// Run directly: `cd backend && node test/feedback-endpoint.test.js`.

process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

let passed = 0, failed = 0;
function check(label, cond) {
    if (cond) { passed++; console.log(`PASS — ${label}`); }
    else { failed++; console.log(`FAIL — ${label}`); }
}

const strings = new Map();
const lists = new Map();
const hashes = new Map();

function run([op, key, ...args]) {
    switch (op.toLowerCase()) {
        case 'incr': { const n = (strings.get(key) ?? 0) + 1; strings.set(key, n); return n; }
        case 'expire': return 1;
        case 'lpush': { const l = lists.get(key) ?? []; l.unshift(...args); lists.set(key, l); return l.length; }
        case 'ltrim': { const l = lists.get(key) ?? []; lists.set(key, l.slice(Number(args[0]), Number(args[1]) + 1)); return 'OK'; }
        case 'hincrby': { const h = hashes.get(key) ?? {}; h[args[0]] = (h[args[0]] ?? 0) + Number(args[1]); hashes.set(key, h); return h[args[0]]; }
        default: throw new Error(`mock does not support ${op}`);
    }
}

globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/pipeline') || url.endsWith('/multi-exec')) {
        return new Response(JSON.stringify(body.map(cmd => ({ result: run(cmd) }))), { status: 200 });
    }
    return new Response(JSON.stringify({ result: run(body) }), { status: 200 });
};

const { default: handler } = await import('../api/feedback.js');

function call(body, method = 'POST') {
    return new Promise(resolve => {
        const res = {
            headers: {}, statusCode: 200,
            setHeader(k, v) { this.headers[k] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ status: this.statusCode, body: b }); },
            end() { resolve({ status: this.statusCode }); }
        };
        handler({ method, body, headers: { 'x-vercel-ip-country': 'AU' } }, res);
    });
}

const meta = { machineId: 'm-test', version: '0.14.3', platform: 'win32', backend: 'cloud' };
const today = new Date().toISOString().slice(0, 10);

let r = await call({ trigger: 'result', rating: 'up', context: 'cloud_edit', meta });
check('a thumbs-up is accepted', r.status === 200 && r.body.ok === true);
const stored = JSON.parse(lists.get(`feedback:items:${today}`)[0]);
check('entry stores rating, trigger, context and version', stored.rating === 'up' && stored.trigger === 'result' && stored.context === 'cloud_edit' && stored.version === '0.14.3');
check('country comes from the edge header', stored.country === 'AU');
check('counts hash tracks trigger:rating', hashes.get(`feedback:counts:${today}`)['result:up'] === 1);

r = await call({ trigger: 'result', rating: 'down', reason: 'too_slow', text: '  slow  ', meta });
check('a thumbs-down with a reason and note is accepted', r.status === 200);
check('text is trimmed', JSON.parse(lists.get(`feedback:items:${today}`)[0]).text === 'slow');
check('reason counted', hashes.get(`feedback:counts:${today}`)['reason:too_slow'] === 1);

r = await call({ trigger: 'manual', text: 'x'.repeat(2000), meta });
check('over-long text is clipped to 500, not rejected', r.status === 200 && JSON.parse(lists.get(`feedback:items:${today}`)[0]).text.length === 500);

check('unknown trigger rejected', (await call({ trigger: 'spam', rating: 'up', meta })).status === 400);
check('unknown rating rejected', (await call({ trigger: 'result', rating: 'meh', meta })).status === 400);
check('unknown reason rejected', (await call({ trigger: 'result', rating: 'down', reason: 'nope', meta })).status === 400);
check('empty submission rejected', (await call({ trigger: 'manual', meta })).status === 400);
check('GET rejected', (await call({}, 'GET')).status === 405);

const entry = JSON.parse(lists.get(`feedback:items:${today}`)[0]);
check('no email or contact field is ever stored', !('email' in entry) && !Object.keys(entry).some(k => /mail|contact|name/i.test(k)));

let last;
for (let i = 0; i < 25; i++) last = await call({ trigger: 'result', rating: 'up', meta: { ...meta, machineId: 'm-flood' } });
check('a single device is rate-limited', last.status === 429);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
