// test/cloud-errors.test.js
//
// Every way a Freebird Cloud request can fail must reach the caller with its own `code`. Before this, a network
// failure, a 500 and a 400 all arrived with no code and were counted together as `api_error:unknown`, so a
// failure report could not say which one the user hit. Also covers the two server answers that used to be
// reported as "took too long": the AI provider failing (502 UPSTREAM_ERROR) and the free tier being full
// (503 GLOBAL_CAPACITY).

const vscodeMock = require('./bootstrap');
const path = require('path');
const { makeFakeContext, suite, check } = require('./helpers');

const { CloudProvider } = require(path.join(__dirname, '..', 'out', 'ai', 'cloud.js'));

const enc = new TextEncoder();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Runs one request against a mocked fetch and returns the error it threw (or null) plus any streamed text. */
async function attempt(fetchImpl, opts) {
    global.fetch = fetchImpl;
    const provider = new CloudProvider(makeFakeContext(), 'sess-test');
    let text = '';
    try {
        await provider.stream([{ role: 'user', content: 'hi' }], c => { text += c; }, opts);
        return { err: null, text };
    } catch (err) {
        return { err, text };
    }
}

async function run() {
    vscodeMock.__setMockConfig({ 'freebird.backend': 'cloud', 'freebird.licenseKey': '' });

    suite('cloud errors: the request never gets an answer');
    {
        const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) });
        const { err } = await attempt(async () => { throw dns; });
        check('a network failure is coded NETWORK_ERROR', err?.code === 'NETWORK_ERROR');
        check('the low-level reason is kept as a short hint', /ENOTFOUND/.test(err?.message ?? ''));
        check('the message tells the user what to check', /connection|VPN|proxy/i.test(err?.message ?? ''));
    }
    {
        const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
        const { err } = await attempt(async () => { throw abort; });
        check('a user cancel is passed through untouched (not a failure)', err === abort && err.code === undefined);
    }
    {
        const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        const { err } = await attempt(async () => { throw timeout; });
        check('our own timeout is still reported as REQUEST_TIMEOUT', err?.code === 'REQUEST_TIMEOUT');
    }

    suite('cloud errors: HTTP errors keep their code');
    {
        const { err } = await attempt(async () => json(500, { error: 'Internal error', code: 'SERVER_ERROR' }));
        check('a 500 with a server code keeps that code', err?.code === 'SERVER_ERROR');
        check('the message still names the HTTP status', /500/.test(err?.message ?? ''));
    }
    {
        const { err } = await attempt(async () => new Response('Request Entity Too Large', { status: 413 }));
        check('a non-JSON error is coded by its HTTP status', err?.code === 'HTTP_413');
    }
    {
        const { err } = await attempt(async () => json(400, { error: 'bad', code: 'not a clean code!!' }));
        check('an unsafe code from the server is not trusted; the status is used instead', err?.code === 'HTTP_400');
    }

    suite('cloud errors: 502/503/504');
    {
        const { err } = await attempt(async () => json(502, { error: 'AI provider error', code: 'UPSTREAM_ERROR', status: 500 }));
        check('a provider failure is coded UPSTREAM_ERROR, not GATEWAY_TIMEOUT', err?.code === 'UPSTREAM_ERROR');
        check('it does not claim the request timed out', !/took too long|timed out/i.test(err?.message ?? ''));
    }
    {
        const { err } = await attempt(async () => json(503, { error: 'Free tier is temporarily at capacity. Please try again later or upgrade to Pro.', code: 'GLOBAL_CAPACITY' }));
        check('free-tier capacity is coded GLOBAL_CAPACITY', err?.code === 'GLOBAL_CAPACITY');
        check('the server message is shown as written', /at capacity/.test(err?.message ?? ''));
    }
    {
        const { err } = await attempt(async () => new Response('<html>Gateway Timeout</html>', { status: 504 }));
        check('a bare gateway timeout is still GATEWAY_TIMEOUT', err?.code === 'GATEWAY_TIMEOUT');
    }

    suite('cloud errors: the connection dies mid-answer');
    {
        const body = new ReadableStream({
            start(c) { c.enqueue(enc.encode('partial answer ')); },
            pull() { throw new TypeError('terminated'); }
        });
        // Make the stream error after the first chunk has been delivered.
        const failing = new ReadableStream({
            start(controller) { controller.enqueue(enc.encode('partial answer ')); },
            async pull(controller) { await new Promise(r => setTimeout(r, 5)); controller.error(new TypeError('terminated')); }
        });
        void body;
        const { err, text } = await attempt(async () => new Response(failing, { status: 200 }));
        check('a dropped stream is coded STREAM_DROPPED', err?.code === 'STREAM_DROPPED');
        check('text that already arrived was delivered', text === 'partial answer ');
        check('the message says it dropped partway', /partway/.test(err?.message ?? ''));
    }

    suite('cloud errors: normal answers are unaffected');
    {
        const { err, text } = await attempt(async () => new Response(new ReadableStream({
            start(c) { c.enqueue(enc.encode('hello ')); c.enqueue(enc.encode('world')); c.close(); }
        }), { status: 200 }));
        check('a normal answer streams with no error', err === null && text === 'hello world');
    }
    {
        const { err } = await attempt(async () => new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 }));
        check('an empty answer is still EMPTY_RESPONSE', err?.code === 'EMPTY_RESPONSE');
    }
    {
        const { err } = await attempt(async () => json(429, { error: 'quota', code: 'QUOTA_EXCEEDED' }));
        check('quota exhaustion is still QUOTA_EXCEEDED', err?.code === 'QUOTA_EXCEEDED');
    }
}

module.exports = { run };

if (require.main === module) {
    const { summary } = require('./helpers');
    run().then(() => process.exit(summary() ? 0 : 1));
}
