// backend/test/template-haiku-routing.test.js — exercises the REAL
// api/chat.js handler for the free-template Haiku-routing feature: a
// templateId matching one of the 3 free built-in templates should route to
// Anthropic (with a 1/day cap for free-tier identities), a valid
// templateLicenseKey should get unlimited Haiku, and anything else should be
// completely unaffected (still Gemini).
//
// Requires `npm install` inside backend/ first. Not wired into the root
// `npm test` suite — same reasoning as templates-endpoint.test.js (root
// suite stays free of backend/node_modules). Run directly:
// `cd backend && node test/template-haiku-routing.test.js`.
//
// Mocks global fetch for three destinations: the Upstash REST wire protocol
// (same shape confirmed empirically for templates-endpoint.test.js), a fake
// Gemini streaming response, and a fake Anthropic streaming response — lets
// the real routing logic in chat.js run unmodified and just inspects which
// upstream actually got called.

process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

let passed = 0, failed = 0;
function check(label, cond) {
    if (cond) { passed++; console.log(`PASS — ${label}`); }
    else { failed++; console.log(`FAIL — ${label}`); }
}

let store; // { counters: Map, strings: Map }
let calls; // { gemini: number, anthropic: number }

function resetState() {
    store = { counters: new Map(), strings: new Map() };
    calls = { gemini: 0, anthropic: 0 };
}

function execRedisCommand([op, ...args]) {
    switch (op) {
        case 'get': {
            if (store.strings.has(args[0])) {
                return { result: Buffer.from(JSON.stringify(store.strings.get(args[0]))).toString('base64') };
            }
            return { result: null };
        }
        case 'incr': {
            const cur = (store.counters.get(args[0]) ?? 0) + 1;
            store.counters.set(args[0], cur);
            return { result: cur };
        }
        case 'decr': {
            const cur = (store.counters.get(args[0]) ?? 0) - 1;
            store.counters.set(args[0], cur);
            return { result: cur };
        }
        case 'expire': return { result: 1 };
        case 'sadd': return { result: 1 };
        default: return { result: null };
    }
}

globalThis.fetch = async (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    if (urlStr.startsWith('https://fake.upstash.io')) {
        const commands = JSON.parse(opts.body);
        const results = commands.map(execRedisCommand);
        return new Response(JSON.stringify(results), { status: 200 });
    }

    if (urlStr.includes('generativelanguage.googleapis.com')) {
        calls.gemini++;
        const sse = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini reply' }] } }] }) + '\n\n';
        return new Response(sse, { status: 200 });
    }

    if (urlStr.includes('api.anthropic.com')) {
        calls.anthropic++;
        const sse = 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'haiku reply' } }) + '\n\n';
        return new Response(sse, { status: 200 });
    }

    return new Response('not found', { status: 404 });
};

function makeReqRes(body) {
    const headers = {};
    let statusCode = 200;
    let jsonBody = null;
    let writtenText = '';
    let ended = false;

    const req = { method: 'POST', headers: {}, body };
    const res = {
        get headersSent() { return Object.keys(headers).length > 0 && ended === false ? false : ended; },
        setHeader(k, v) { headers[k] = v; },
        status(code) { statusCode = code; return this; },
        json(obj) { jsonBody = obj; return this; },
        write(chunk) { writtenText += chunk; },
        end() { ended = true; },
        _get: () => ({ statusCode, headers, jsonBody, writtenText }),
    };
    return { req, res };
}

// Consume the response's readable stream the same way the real caller (the
// extension) would, so the handler's write()/end() calls actually complete.
async function drain(res) {
    // handler awaits internally; nothing else needed since it's all done by
    // the time handler(req, res) resolves — this helper exists for clarity.
    return res._get();
}

async function run() {
    const { default: handler } = await import('../api/chat.js');

    console.log('\n--- free tier: first template call of the day -> Haiku, bonus consumed ---');
    {
        resetState();
        const { req, res } = makeReqRes({
            messages: [{ role: 'user', content: 'run codebase cartographer' }],
            sessionId: 'session-a',
            templateId: 'codebase-cartographer',
        });
        await handler(req, res);
        const out = await drain(res);
        check('routed to Anthropic', calls.anthropic === 1 && calls.gemini === 0);
        check('X-Template-Bonus-Used header set', out.headers['X-Template-Bonus-Used'] === 'true');
    }

    console.log('\n--- free tier: second same-day template call -> falls back to Gemini, not blocked ---');
    {
        // Reuse the same store (same identity, same day) but reset call counters
        calls = { gemini: 0, anthropic: 0 };
        const { req, res } = makeReqRes({
            messages: [{ role: 'user', content: 'run codebase cartographer again' }],
            sessionId: 'session-a',
            templateId: 'codebase-cartographer',
        });
        await handler(req, res);
        const out = await drain(res);
        check('falls back to Gemini (bonus already used today)', calls.gemini === 1 && calls.anthropic === 0);
        check('no X-Template-Bonus-Used header this time', !out.headers['X-Template-Bonus-Used']);
        check('request still succeeds (200), not blocked', out.statusCode === 200 || out.statusCode === undefined);
    }

    console.log('\n--- templateLicenseKey (paid $3/mo subscriber): unlimited, ignores daily counter ---');
    {
        resetState();
        store.strings.set('license:FB-TMPL-TMPL-TMPL-TMPL', { status: 'active', plan: 'templates', templateLibrary: true });
        for (let i = 0; i < 3; i++) {
            calls = { gemini: 0, anthropic: 0 };
            const { req, res } = makeReqRes({
                messages: [{ role: 'user', content: 'run security auditor' }],
                sessionId: 'session-b',
                templateId: 'security-auditor',
                templateLicenseKey: 'fb-tmpl-tmpl-tmpl-tmpl',
            });
            await handler(req, res);
            check(`call ${i + 1}/3 still routed to Anthropic (unlimited)`, calls.anthropic === 1 && calls.gemini === 0);
        }
    }

    console.log('\n--- non-template chat message: completely unaffected ---');
    {
        resetState();
        calls = { gemini: 0, anthropic: 0 };
        const { req, res } = makeReqRes({
            messages: [{ role: 'user', content: 'just a normal question, no template' }],
            sessionId: 'session-c',
        });
        await handler(req, res);
        const out = await drain(res);
        check('free-tier non-template message still goes to Gemini as before', calls.gemini === 1 && calls.anthropic === 0);
        check('no X-Template-Bonus-Used header', !out.headers['X-Template-Bonus-Used']);
    }

    console.log('\n--- unknown templateId (not one of the 3 free ones): treated as non-template ---');
    {
        resetState();
        calls = { gemini: 0, anthropic: 0 };
        const { req, res } = makeReqRes({
            messages: [{ role: 'user', content: 'hi' }],
            sessionId: 'session-d',
            templateId: 'some-paid-template-not-in-free-allowlist',
        });
        await handler(req, res);
        check('not eligible for the free bonus, still Gemini', calls.gemini === 1 && calls.anthropic === 0);
    }

    console.log(`\n${passed}/${passed + failed} checks passed`);
    return failed === 0;
}

run().then(ok => process.exit(ok ? 0 : 1));
