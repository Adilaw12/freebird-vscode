// test/paddle-license.test.js — Paddle status to licence status.

import { licenseStatusForPaddle } from '../lib/paddleLicense.js';

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

console.log('\n--- Paddle status mapping ---');
check('active maps to active', licenseStatusForPaddle('active') === 'active');
check('trialing maps to active', licenseStatusForPaddle('trialing') === 'active');
check('past_due maps to past_due', licenseStatusForPaddle('past_due') === 'past_due');
check('canceled maps to cancelled', licenseStatusForPaddle('canceled') === 'cancelled');
check('paused maps to cancelled', licenseStatusForPaddle('paused') === 'cancelled');
check('an unknown status leaves the licence alone', licenseStatusForPaddle('something_new') === null);

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
