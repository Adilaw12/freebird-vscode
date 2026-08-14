// test/anthropic-fallback.test.js — tests backend/lib/anthropicModel.js.
// Mirrors gemini-fallback.test.js's dynamic-import approach for this ESM
// module. Unlike Gemini's list, ANTHROPIC_MODEL_CANDIDATES deliberately has
// only one entry today (see the file's own comment on why), so the
// multi-candidate fallback behavior is exercised with a locally-built
// two-model list passed via the function's own `candidates` override param,
// rather than assuming a second real candidate exists.

const path = require('path');
const { suite, check, summary } = require('./helpers');

async function run() {
    process.env.ANTHROPIC_API_KEY = 'test-key'; // must be set before the module loads

    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'anthropicModel.js');
    const { fetchAnthropicWithFallback, ANTHROPIC_MODEL_CANDIDATES, anthropicConfigured } = await import(`file://${modPath}`);

    check('anthropicConfigured() is true once ANTHROPIC_API_KEY is set', anthropicConfigured() === true);
    check('there is at least one real candidate', ANTHROPIC_MODEL_CANDIDATES.length >= 1);

    suite('fetchAnthropicWithFallback: primary succeeds');
    {
        let calls = 0;
        global.fetch = async () => { calls++; return { ok: true, status: 200 }; };
        const { modelUsed } = await fetchAnthropicWithFallback({});
        check('only calls fetch once when the primary succeeds', calls === 1);
        check('reports the primary model as the one used', modelUsed === ANTHROPIC_MODEL_CANDIDATES[0]);
    }

    suite('fetchAnthropicWithFallback: primary 404s, second (locally supplied) candidate succeeds');
    {
        const candidates = ['claude-test-primary', 'claude-test-secondary'];
        let calls = 0;
        global.fetch = async () => {
            calls++;
            if (calls === 1) return { ok: false, status: 404, text: async () => 'not found' };
            return { ok: true, status: 200 };
        };
        const { response, modelUsed } = await fetchAnthropicWithFallback({}, {}, candidates);
        check('advances to the second candidate on a 404', calls === 2);
        check('reports the second model as the one that actually served the request', modelUsed === candidates[1]);
        check('returns the successful response', response.ok === true);
    }

    suite('fetchAnthropicWithFallback: primary 429s (rate limit) — must NOT retry across models');
    {
        const candidates = ['claude-test-primary', 'claude-test-secondary'];
        let calls = 0;
        global.fetch = async () => { calls++; return { ok: false, status: 429, text: async () => 'rate limited' }; };
        const { response, modelUsed } = await fetchAnthropicWithFallback({}, {}, candidates);
        check('does not retry across models on a non-404 failure (rate limit isn\'t fixed by switching models)', calls === 1);
        check('returns the failed response as-is', response.ok === false && response.status === 429);
        check('reports the primary model, since that\'s what actually failed', modelUsed === candidates[0]);
    }

    suite('fetchAnthropicWithFallback: every candidate 404s');
    {
        const candidates = ['claude-test-primary', 'claude-test-secondary'];
        let calls = 0;
        global.fetch = async () => { calls++; return { ok: false, status: 404, text: async () => 'not found' }; };
        const { response } = await fetchAnthropicWithFallback({}, {}, candidates);
        check('tries every candidate in the chain before giving up', calls === candidates.length);
        check('returns the last failed response when everything is exhausted', response.ok === false);
    }

    suite('fetchAnthropicWithFallback: request body carries the model per-candidate');
    {
        let sentBody = null;
        global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return { ok: true, status: 200 }; };
        await fetchAnthropicWithFallback({ max_tokens: 512, messages: [] });
        check('the model field is set on the outgoing request body', sentBody.model === ANTHROPIC_MODEL_CANDIDATES[0]);
        check('the rest of the request body is preserved', sentBody.max_tokens === 512);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
