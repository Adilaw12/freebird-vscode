// test/license-status.test.js
//
// Verifies getLicenseStatus() correctly parses every plan type the backend
// can return, and that isPro is true for all of them (Team/Enterprise/trial
// users get the same feature gate as Pro — only quota/pricing differs).

const vscodeMock = require('./bootstrap');
const path = require('path');
const { makeFakeContext, suite, check, checkAsync, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', 'out');
const { getLicenseStatus } = require(path.join(OUT, 'license/validator.js'));

async function run() {
    suite('getLicenseStatus parses every plan type correctly');

    const cases = [
        { serverPlan: 'pro',        expectPlan: 'pro' },
        { serverPlan: 'enterprise', expectPlan: 'enterprise' },
        { serverPlan: 'team',       expectPlan: 'team' },
        { serverPlan: 'trial',      expectPlan: 'trial' },
        { serverPlan: undefined,    expectPlan: 'pro' } // legacy/missing plan field defaults to pro
    ];

    for (const { serverPlan, expectPlan } of cases) {
        vscodeMock.__setMockConfig({ 'freebird.licenseKey': `FB-TEST-${expectPlan.toUpperCase()}` });
        global.fetch = async () => ({
            ok: true,
            json: async () => ({ valid: true, plan: serverPlan, email: '[email protected]' })
        });

        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check(`plan "${serverPlan}" -> isPro:true`, status.isPro === true);
        check(`plan "${serverPlan}" -> parsed as "${expectPlan}"`, status.plan === expectPlan);
    }

    suite('an inactive/invalid license never reports isPro:true');
    vscodeMock.__setMockConfig({ 'freebird.licenseKey': 'FB-TEST-INVALID' });
    global.fetch = async () => ({ ok: true, json: async () => ({ valid: false }) });
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('valid:false from server -> isPro:false', status.isPro === false);
    }

    suite('a server error does not silently grant Pro access');
    vscodeMock.__setMockConfig({ 'freebird.licenseKey': 'FB-TEST-SERVERERROR' });
    global.fetch = async () => ({ ok: false });
    {
        const ctx = makeFakeContext();
        const status = await getLicenseStatus(ctx);
        check('non-ok response with no prior cache -> isPro:false (fails closed)', status.isPro === false);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
