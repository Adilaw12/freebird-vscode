// test/byok-gate.test.js
//
// Regression test for the BYOK license gap fixed in v0.8.2: getProvider()
// must never hand back a BYOK provider (Anthropic/OpenAI/DeepSeek/Qwen)
// unless the cached license status says isPro. Run this before every
// publish — this exact gap shipped silently for a long time before anyone
// noticed, precisely because there was no test catching it.

const vscodeMock = require('./bootstrap');
const path = require('path');
const { makeFakeContext, suite, check, checkAsync, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');

const { getLicenseStatus, getCachedLicenseStatus } = require(path.join(OUT, 'license/validator.js'));
const { getProvider } = require(path.join(OUT, 'ai/index.js'));
const { CloudProvider } = require(path.join(OUT, 'ai/cloud.js'));
const { OpenAIProvider } = require(path.join(OUT, 'ai/openai.js'));

async function run() {
    suite('backend=openai, no license configured at all');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': '' });
    vscodeMock.__resetCalls();
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('getLicenseStatus with empty key returns isPro:false', status.isPro === false);

        const provider = getProvider(ctx, 'sess-a');
        check('getProvider returns CloudProvider, not OpenAIProvider, when unlicensed', provider instanceof CloudProvider && !(provider instanceof OpenAIProvider));
        check('a one-time warning is shown explaining BYOK requires a license', vscodeMock.__getCalls().showWarningMessage.length === 1);
    }

    suite('backend=openai, license key set but server rejects it');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': 'FB-FAKE-FAKE-FAKE-FAKE' });
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
        check('getProvider returns CloudProvider for a rejected license', provider instanceof CloudProvider && !(provider instanceof OpenAIProvider));
    }

    suite('backend=openai, a real active Pro license');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': 'FB-REAL-REAL-REAL-REAL', 'freebird.apiKey': 'sk-test' });
    vscodeMock.__resetCalls();
    global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, plan: 'pro', email: '[email protected]' }) });
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('valid Pro key returns isPro:true', status.isPro === true);
        check('getCachedLicenseStatus reflects the warmed cache synchronously', getCachedLicenseStatus().isPro === true);

        const provider = getProvider(ctx, 'sess-c');
        check('getProvider returns OpenAIProvider for an active Pro license', provider instanceof OpenAIProvider);
    }

    suite('backend=openai, an active trial license (must also unlock BYOK)');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'openai', 'freebird.licenseKey': 'FB-TRIAL-TRIAL-TRIAL', 'freebird.apiKey': 'sk-test' });
    vscodeMock.__resetCalls();
    global.fetch = async () => ({ ok: true, json: async () => ({ valid: true, plan: 'trial', email: '[email protected]' }) });
    {
        const ctx = makeFakeContext();
        await getLicenseStatus(ctx);
        const provider = getProvider(ctx, 'sess-d');
        check('trial-plan users also get BYOK, not just pro/team/enterprise', provider instanceof OpenAIProvider);
    }

    suite('backend=ollama, no license — sanity check this was never gated');
    vscodeMock.__setMockConfig({ 'freebird.backend': 'ollama', 'freebird.licenseKey': '' });
    vscodeMock.__resetCalls();
    {
        const ctx = makeFakeContext();
        const provider = getProvider(ctx, 'sess-e');
        check('no BYOK warning is shown for Ollama (always free, never gated)', vscodeMock.__getCalls().showWarningMessage.length === 0);
        check('Ollama backend still returns a working provider', !!provider && typeof provider.stream === 'function');
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
