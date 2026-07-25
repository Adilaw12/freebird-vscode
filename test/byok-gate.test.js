// test/byok-gate.test.js
//
// Regression test for BYOK routing. Through v0.8.8, getProvider() required
// an active Pro/Team/Enterprise/trial license before handing back a BYOK
// provider (Anthropic/OpenAI/DeepSeek/Qwen) — silently falling back to
// CloudProvider otherwise. As of v0.8.9 that gate is gone: BYOK backends
// are free for everyone regardless of license status, since the user's own
// key means the call never touches Freebird's infrastructure. This locks in
// that getProvider() honors the configured BYOK backend unconditionally.

const vscodeMock = require('./bootstrap');
const path = require('path');
const { makeFakeContext, suite, check, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');

const { getLicenseStatus } = require(path.join(OUT, 'license/validator.js'));
const { getProvider } = require(path.join(OUT, 'ai/index.js'));
const { CloudProvider } = require(path.join(OUT, 'ai/cloud.js'));
const { OpenAIProvider } = require(path.join(OUT, 'ai/openai.js'));

async function run() {
    suite('backend=openai, no license configured at all');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': '', 'freebird.apiKey': 'sk-test' });
    vscodeMock.__resetCalls();
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('getLicenseStatus with empty key returns isPro:false', status.isPro === false);

        const provider = getProvider(ctx, 'sess-a');
        check('getProvider returns OpenAIProvider even when unlicensed (BYOK is free)', provider instanceof OpenAIProvider);
        check('no warning is shown — BYOK no longer requires a license', vscodeMock.__getCalls().showWarningMessage.length === 0);
    }

    suite('backend=openai, license key set but server rejects it');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': 'FB-FAKE-FAKE-FAKE-FAKE', 'freebird.apiKey': 'sk-test' });
    vscodeMock.__resetCalls();
    global.fetch = async (url) => {
        check('license validation calls /api/validate', String(url).includes('/api/validate'));
        return { ok: true, json: async () => ({ valid: false }) };
    };
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('server-rejected key returns isPro:false', status.isPro === false);

        const provider = getProvider(ctx, 'sess-b');
        check('getProvider still returns OpenAIProvider — a rejected license does not block BYOK', provider instanceof OpenAIProvider);
    }

    suite('backend=openai, a real active Pro license');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': 'FB-REAL-REAL-REAL-REAL', 'freebird.apiKey': 'sk-test' });
    vscodeMock.__resetCalls();
    global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, plan: 'pro', email: '[email protected]' }) });
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('valid Pro key returns isPro:true', status.isPro === true);

        const provider = getProvider(ctx, 'sess-c');
        check('getProvider returns OpenAIProvider for an active Pro license', provider instanceof OpenAIProvider);
    }

    suite('backend=cloud, no license — unaffected by the BYOK change');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'cloud', 'freebird.licenseKey': '' });
    vscodeMock.__resetCalls();
    {
        const ctx = makeFakeContext();
        const provider = getProvider(ctx, 'sess-d');
        check('cloud backend still returns CloudProvider', provider instanceof CloudProvider);
    }

    suite('backend=ollama, no license — sanity check this was never gated');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'ollama', 'freebird.licenseKey': '' });
    vscodeMock.__resetCalls();
    {
        const ctx = makeFakeContext();
        const provider = getProvider(ctx, 'sess-e');
        check('no warning is shown for Ollama (always free, never gated)', vscodeMock.__getCalls().showWarningMessage.length === 0);
        check('Ollama backend still returns a working provider', !!provider && typeof provider.stream === 'function');
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
