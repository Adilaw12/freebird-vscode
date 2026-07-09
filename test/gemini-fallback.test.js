// test/gemini-fallback.test.js — tests backend/lib/geminiModel.js, an ESM
// module, via dynamic import() from this CommonJS test file (works fine —
// import() is a function, usable from either module system).

const path = require('path');
const { suite, check, checkAsync, summary } = require('./helpers');

async function run() {
    process.env.GEMINI_API_KEY = 'test-key'; // must be set before the module loads

    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'geminiModel.js');
    const { fetchGeminiWithFallback, GEMINI_MODEL_CANDIDATES } = await import(`file://${modPath}`);

    check('there are at least 2 candidates (a fallback actually exists)', GEMINI_MODEL_CANDIDATES.length >= 2);

    suite('fetchGeminiWithFallback: primary succeeds');
    {
        let calls = 0;
        global.fetch = async () => { calls++; return { ok: true, status: 200 }; };
        const { modelUsed } = await fetchGeminiWithFallback('generateContent', {});
        check('only calls fetch once when the primary succeeds', calls === 1);
        check('reports the primary model as the one used', modelUsed === GEMINI_MODEL_CANDIDATES[0]);
    }

    suite('fetchGeminiWithFallback: primary 404s, second candidate succeeds');
    {
        let calls = 0;
        global.fetch = async () => {
            calls++;
            if (calls === 1) return { ok: false, status: 404, text: async () => 'not found' };
            return { ok: true, status: 200 };
        };
        const { response, modelUsed } = await fetchGeminiWithFallback('generateContent', {});
        check('advances to the second candidate on a 404', calls === 2);
        check('reports the second model as the one that actually served the request', modelUsed === GEMINI_MODEL_CANDIDATES[1]);
        check('returns the successful response', response.ok === true);
    }

    suite('fetchGeminiWithFallback: primary 429s (rate limit) — must NOT retry across models');
    {
        let calls = 0;
        global.fetch = async () => { calls++; return { ok: false, status: 429, text: async () => 'rate limited' }; };
        const { response, modelUsed } = await fetchGeminiWithFallback('generateContent', {});
        check('does not retry across models on a non-404 failure (rate limit isn\'t fixed by switching models)', calls === 1);
        check('returns the failed response as-is', response.ok === false && response.status === 429);
        check('reports the primary model, since that\'s what actually failed', modelUsed === GEMINI_MODEL_CANDIDATES[0]);
    }

    suite('fetchGeminiWithFallback: every candidate 404s');
    {
        let calls = 0;
        global.fetch = async () => { calls++; return { ok: false, status: 404, text: async () => 'not found' }; };
        const { response } = await fetchGeminiWithFallback('generateContent', {});
        check('tries every candidate in the chain before giving up', calls === GEMINI_MODEL_CANDIDATES.length);
        check('returns the last failed response when everything is exhausted', response.ok === false);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
