// test/license-grace.test.js — which licenses keep Pro while a renewal is failing.

import { isLicenseActive, PAST_DUE_GRACE_DAYS } from '../lib/license.js';

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(Date.now() - n * DAY).toISOString();

console.log('\n--- past_due grace period ---');
check('grace period is 7 days', PAST_DUE_GRACE_DAYS === 7);
check('an active Pro license is active', isLicenseActive({ status: 'active', plan: 'pro' }));
check('a past_due Pro license inside grace stays active',
    isLicenseActive({ status: 'past_due', plan: 'pro', pastDueSince: daysAgo(2) }));
check('a past_due Team license inside grace stays active',
    isLicenseActive({ status: 'past_due', plan: 'team', pastDueSince: daysAgo(1) }));
check('a past_due Pro license past grace is not active',
    !isLicenseActive({ status: 'past_due', plan: 'pro', pastDueSince: daysAgo(8) }));
check('an older past_due record with no pastDueSince uses updatedAt',
    isLicenseActive({ status: 'past_due', plan: 'pro', updatedAt: daysAgo(3) }));
check('a past_due record with no dates at all is not active',
    !isLicenseActive({ status: 'past_due', plan: 'pro' }));
check('a cancelled license is not active, even inside the window',
    !isLicenseActive({ status: 'cancelled', plan: 'pro', pastDueSince: daysAgo(1) }));
check('past_due on a templates-only license grants nothing',
    !isLicenseActive({ status: 'past_due', plan: 'templates', pastDueSince: daysAgo(1) }));
check('an expired trial is not active',
    !isLicenseActive({ status: 'active', plan: 'trial', trialEndsAt: daysAgo(1) }));
check('a missing license is not active', !isLicenseActive(undefined));

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
