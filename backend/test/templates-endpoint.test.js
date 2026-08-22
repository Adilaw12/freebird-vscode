// backend/test/templates-endpoint.test.js — exercises the REAL api/templates.js
// handler end-to-end against a mocked Upstash wire protocol, instead of only
// testing the extracted hasTemplateLibraryAccess() logic (see
// ../../test/template-access.test.js for that).
//
// Requires `npm install` inside backend/ first (@upstash/redis, stripe aren't
// installed by the root project's `npm install` — separate package.json).
// Not wired into the root `npm test` suite for that reason (root test suite
// deliberately stays dependency-free of backend/node_modules — see
// test/share-escape.test.js's comment for the established precedent). Run
// directly: `cd backend && node test/templates-endpoint.test.js`.
//
// Mocks global fetch — the actual boundary @upstash/redis's REST client uses
// under the hood (confirmed by probing it: POST {baseUrl}/pipeline with body
// `[["get","key"]]`, response `[{result: base64(json)}]`) — same style as
// the root suite's license-status.test.js stubbing fetch for validator.ts.

process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

let passed = 0, failed = 0;
function check(label, cond) {
    if (cond) { passed++; console.log(`PASS — ${label}`); }
    else { failed++; console.log(`FAIL — ${label}`); }
}

// In-memory Redis stand-in, keyed exactly like the real store (`license:KEY`).
let store = new Map();

globalThis.fetch = async (url, opts) => {
    if (!url.endsWith('/pipeline')) {
        return new Response(JSON.stringify({ error: 'unexpected non-pipeline request in mock' }), { status: 500 });
    }
    const commands = JSON.parse(opts.body); // e.g. [["get","license:FB-..."]]
    const results = commands.map(cmd => {
        const [op, key] = cmd;
        if (op !== 'get') return { result: null, error: `mock does not support ${op}` };
        const value = store.get(key);
        if (value === undefined) return { result: null };
        return { result: Buffer.from(JSON.stringify(value)).toString('base64') };
    });
    return new Response(JSON.stringify(results), { status: 200 });
};

function makeReqRes(body, { origin } = {}) {
    const req = { method: 'POST', headers: origin ? { origin } : {}, body };
    const res = {
        _status: 200,
        _json: null,
        setHeader() {},
        status(code) { this._status = code; return this; },
        json(obj) { this._json = obj; return this; },
        end() { return this; }
    };
    return { req, res };
}

async function run() {
    const { default: handler } = await import('../api/templates.js');

    const activeAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();

    console.log('\n--- no license key provided ---');
    {
        store = new Map();
        const { req, res } = makeReqRes({});
        await handler(req, res);
        check('200 response', res._status === 200);
        check('catalog is non-empty', res._json.templates.length > 0);
        check('every item is locked', res._json.templates.every(t => t.locked === true));
        check('no prompt text leaks for locked items', res._json.templates.every(t => t.prompt === undefined));
    }

    console.log('\n--- valid active Pro license key (bundled perk) ---');
    {
        store = new Map();
        store.set('license:FB-PROX-PROX-PROX-PROX', { status: 'active', plan: 'pro' });
        const { req, res } = makeReqRes({ licenseKey: 'fb-prox-prox-prox-prox' }); // lowercase on purpose — must normalise
        await handler(req, res);
        check('every item is unlocked', res._json.templates.every(t => t.locked === false));
        check('prompt text is present for unlocked items', res._json.templates.every(t => typeof t.prompt === 'string' && t.prompt.length > 0));
    }

    console.log('\n--- valid standalone templates-only license key ---');
    {
        store = new Map();
        store.set('license:FB-TMPL-TMPL-TMPL-TMPL', { status: 'active', plan: 'templates', templateLibrary: true });
        const { req, res } = makeReqRes({ templateLicenseKey: 'FB-TMPL-TMPL-TMPL-TMPL' });
        await handler(req, res);
        check('unlocked via the templates-only key', res._json.templates.every(t => t.locked === false));
    }

    console.log('\n--- cancelled Pro license ---');
    {
        store = new Map();
        store.set('license:FB-DEAD-DEAD-DEAD-DEAD', { status: 'cancelled', plan: 'pro' });
        const { req, res } = makeReqRes({ licenseKey: 'FB-DEAD-DEAD-DEAD-DEAD' });
        await handler(req, res);
        check('cancelled license stays locked', res._json.templates.every(t => t.locked === true));
    }

    console.log('\n--- malformed key format is rejected without a lookup ---');
    {
        store = new Map();
        // If this were looked up, the mock would 500 on an unexpected key; it must not be looked up at all.
        const { req, res } = makeReqRes({ licenseKey: 'not-a-real-key' });
        await handler(req, res);
        check('malformed key -> still 200, still locked (fails closed)', res._status === 200 && res._json.templates.every(t => t.locked === true));
    }

    console.log('\n--- expired trial license ---');
    {
        store = new Map();
        const expiredAt = new Date(Date.now() - 1000).toISOString();
        store.set('license:FBT-EXPD-EXPD-EXPD-EXPD', { status: 'active', plan: 'trial', trialEndsAt: expiredAt });
        const { req, res } = makeReqRes({ licenseKey: 'FBT-EXPD-EXPD-EXPD-EXPD' });
        await handler(req, res);
        check('expired trial stays locked', res._json.templates.every(t => t.locked === true));
    }

    console.log('\n--- active trial license (bundled perk) ---');
    {
        store = new Map();
        store.set('license:FBT-LIVE-LIVE-LIVE-LIVE', { status: 'active', plan: 'trial', trialEndsAt: activeAt });
        const { req, res } = makeReqRes({ licenseKey: 'FBT-LIVE-LIVE-LIVE-LIVE' });
        await handler(req, res);
        check('active trial unlocks the catalog', res._json.templates.every(t => t.locked === false));
    }

    console.log('\n--- CORS / method handling ---');
    {
        const { req, res } = makeReqRes({}, {});
        req.method = 'GET';
        await handler(req, res);
        check('GET is rejected (405)', res._status === 405);
    }
    {
        const { req, res } = makeReqRes({}, { origin: 'https://evil.example' });
        await handler(req, res);
        check('unrecognised Origin is rejected (403)', res._status === 403);
    }

    console.log(`\n${passed}/${passed + failed} checks passed`);
    return failed === 0;
}

run().then(ok => process.exit(ok ? 0 : 1));
