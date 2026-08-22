// test/template-access.test.js — tests backend/lib/license.js's
// hasTemplateLibraryAccess(), an ESM module, via dynamic import() (same
// pattern as gemini-fallback.test.js/anthropic-fallback.test.js).
//
// The one test that matters most here: a templates-only license must NEVER
// pass isLicenseActive() — that's the guard against leaking free unlimited
// Pro chat/cloud edits to someone who only paid for the template library.

const path = require('path');
const { suite, check, summary } = require('./helpers');

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'license.js');
    const { isLicenseActive, hasTemplateLibraryAccess } = await import(`file://${modPath}`);

    const activeAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();

    suite('hasTemplateLibraryAccess: templates-only purchase');
    {
        const license = { status: 'active', plan: 'templates', templateLibrary: true };
        check('grants template access', hasTemplateLibraryAccess(license) === true);
        check('CRITICAL: does NOT count as an active Pro license', isLicenseActive(license) === false);
    }

    suite('hasTemplateLibraryAccess: Pro/Enterprise/Team/trial get it bundled free');
    {
        for (const plan of ['pro', 'enterprise', 'team']) {
            const license = { status: 'active', plan };
            check(`${plan}: bundled template access via isLicenseActive`, hasTemplateLibraryAccess(license) === true);
        }
        const trial = { status: 'active', plan: 'trial', trialEndsAt: activeAt };
        check('active trial: bundled template access', hasTemplateLibraryAccess(trial) === true);
    }

    suite('hasTemplateLibraryAccess: inactive/cancelled license fails regardless of templateLibrary flag');
    {
        const cancelled = { status: 'cancelled', plan: 'templates', templateLibrary: true };
        check('cancelled templates license -> no access', hasTemplateLibraryAccess(cancelled) === false);

        const pastDue = { status: 'past_due', plan: 'pro' };
        check('past_due pro license -> no access', hasTemplateLibraryAccess(pastDue) === false);
    }

    suite('hasTemplateLibraryAccess: missing/malformed license');
    {
        check('null license -> no access', hasTemplateLibraryAccess(null) === false);
        check('active license with no templateLibrary flag and no qualifying plan -> no access',
            hasTemplateLibraryAccess({ status: 'active', plan: 'free' }) === false);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
