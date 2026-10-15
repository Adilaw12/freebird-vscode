// backend/test/chat-completion-fallback.test.js — api/chat.js: free-tier tab completions on Cerebras, with
// Gemini as the fallback when Cerebras errors OR comes back with no text.
//
// Runs the real handler against a local fake Upstash REST server and a mocked fetch for Cerebras and Gemini.
// Run directly: `cd backend && node test/chat-completion-fallback.test.js`.

import http from 'node:http';

let passed = 0, failed = 0;
function check(label, cond) { if (cond) { passed++; console.log(`PASS — ${label}`); } else { failed++; console.log(`FAIL — ${label}`); } }

// ── Fake Upstash REST server: counters work, everything else answers harmlessly ──
const hincrby = [];            // [key, field] for every HINCRBY seen
const counters = new Map();
function runCommand([cmd, ...args]) {
    switch (String(cmd).toUpperCase()) {
        case 'INCR': { const n = (counters.get(args[0]) ?? 0) + 1; counters.set(args[0], n); return n; }
        case 'DECR': { const n = (counters.get(args[0]) ?? 0) - 1; counters.set(args[0], n); return n; }
        case 'HINCRBY': hincrby.push([args[0], args[1]]); return 1;
        case 'GET': return null;
        default: return 1; // EXPIRE, SADD, ...
    }
}
const redisServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const payload = JSON.parse(body || '[]');
        const out = req.url.includes('pipeline')
            ? payload.map(cmd => ({ result: runCommand(cmd) }))
            : { result: runCommand(payload) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(out));
    });
});
await new Promise(r => redisServer.listen(0, '127.0.0.1', r));

process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${redisServer.address().port}`;
process.env.UPSTASH_REDIS_REST_TOKEN = 'test';
process.env.GEMINI_API_KEY = 'test-gemini';
process.env.CEREBRAS_API_KEY = 'test-cerebras';

// ── Mocked providers (anything else, i.e. the fake Redis, goes through the real fetch) ──
const realFetch = globalThis.fetch;
let cerebrasMode = 'content';
const enc = new TextEncoder();
const sseResponse = (...lines) => new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close(); }
}), { status: 200 });
const cdelta = (d, finish = null) => `data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: finish }] })}\n\n`;
const calls = { cerebras: 0, gemini: 0 };

globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.cerebras.ai')) {
        calls.cerebras++;
        if (cerebrasMode === 'content') return sseResponse(cdelta({ reasoning: 'hmm' }), cdelta({ content: 'cerebras text' }, 'stop'), 'data: [DONE]\n\n');
        if (cerebrasMode === 'empty')   return sseResponse(cdelta({ reasoning: 'thinking...' }), cdelta({}, 'length'), 'data: [DONE]\n\n');
        if (cerebrasMode === '429')     return new Response('{"error":"rate limited"}', { status: 429 });
        if (cerebrasMode === 'throw')   throw new Error('network down');
    }
    if (u.includes('generativelanguage.googleapis.com')) {
        calls.gemini++;
        return sseResponse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini text' }] } }] })}\n\n`);
    }
    return realFetch(url, opts);
};

const { default: handler } = await import('../api/chat.js');

async function complete() {
    const out = { headers: {}, written: '', status: 200, json: null, ended: false };
    const res = {
        setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
        write(t) { out.written += t; return true; },
        end() { out.ended = true; },
        status(code) { out.status = code; return { json(b) { out.json = b; out.ended = true; } }; },
        headersSent: false
    };
    const req = {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        body: {
            messages: [{ role: 'system', content: 'You complete code.' }, { role: 'user', content: 'File: a.ts (typescript)\n\nconst x = <CURSOR>' }],
            sessionId: `s-${Math.random().toString(36).slice(2)}`,
            maxTokens: 128,
            isTabCompletion: true
        }
    };
    await handler(req, res);
    return out;
}
const statFields = () => hincrby.filter(([k]) => k.startsWith('telemetry:completions:')).map(([, f]) => f);

// A: Cerebras answers normally.
cerebrasMode = 'content'; calls.cerebras = calls.gemini = 0; hincrby.length = 0;
let r = await complete();
check('A: Cerebras text is sent to the user', r.written === 'cerebras text' && r.ended);
check('A: served by gpt-oss-120b with no fallback header', r.headers['x-model-used'] === 'gpt-oss-120b' && r.headers['x-completion-fallback'] === undefined);
check('A: Gemini was not called', calls.gemini === 0 && calls.cerebras === 1);
check('A: cerebras:ok is counted', statFields().join() === 'cerebras:ok');

// B: Cerebras reasons until its budget runs out and returns no text — the reported bug.
cerebrasMode = 'empty'; calls.cerebras = calls.gemini = 0; hincrby.length = 0;
r = await complete();
check('B: an empty Cerebras reply falls back to Gemini and the user gets text', r.written === 'gemini text' && r.ended);
check('B: the reply is marked as served by Gemini after a Cerebras failure', /gemini/i.test(r.headers['x-model-used']) && r.headers['x-completion-fallback'] === 'cerebras');
check('B: Cerebras was tried once and Gemini once', calls.cerebras === 1 && calls.gemini === 1);
check('B: the empty reply and its reason are counted, plus the Gemini fallback',
    statFields().includes('cerebras:empty') && statFields().includes('cerebras:empty:length+reasoning') && statFields().includes('gemini:after_cerebras_fail'));

// C: Cerebras rate-limits.
cerebrasMode = '429'; calls.cerebras = calls.gemini = 0; hincrby.length = 0;
r = await complete();
check('C: a Cerebras 429 falls back to Gemini', r.written === 'gemini text' && r.headers['x-completion-fallback'] === 'cerebras');
check('C: the 429 is counted', statFields().includes('cerebras:error:http_429') && statFields().includes('gemini:after_cerebras_fail'));

// D: Cerebras is unreachable.
cerebrasMode = 'throw'; calls.cerebras = calls.gemini = 0; hincrby.length = 0;
r = await complete();
check('D: a Cerebras network error falls back to Gemini', r.written === 'gemini text' && r.headers['x-completion-fallback'] === 'cerebras');
check('D: the exception is counted', statFields().includes('cerebras:error:exception'));

globalThis.fetch = realFetch;
redisServer.close();
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
