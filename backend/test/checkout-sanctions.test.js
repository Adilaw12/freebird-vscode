// test/checkout-sanctions.test.js — no Pro checkout for sanctioned countries.

import { createCheckoutSession } from '../lib/checkoutPricing.js';
import { isBlockedCountry } from '../lib/sanctionedCountries.js';

let total = 0;
let failed = 0;
function check(label, condition) {
    total++;
    if (!condition) failed++;
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}`);
}

// Stripe must never be reached for a blocked country.
const stripeThatFails = {
    checkout: { sessions: { create: async () => { throw new Error('Stripe should not be called'); } } }
};
const env = { appUrl: 'https://example.test' };

console.log('\n--- sanctioned countries ---');
for (const c of ['IR', 'KP', 'CU', 'SY']) {
    const r = await createCheckoutSession(stripeThatFails, { country: c, ...env });
    check(`${c} is refused with 403`, r.status === 403 && !r.session);
}
check('lower-case country codes are also refused', isBlockedCountry('ir'));
check('no country is treated as allowed', isBlockedCountry(null) === false);
check('Nigeria is not blocked', isBlockedCountry('NG') === false);
check('Indonesia is not blocked', isBlockedCountry('ID') === false);
check('Vietnam is not blocked', isBlockedCountry('VN') === false);
check('India is not blocked', isBlockedCountry('IN') === false);

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) process.exit(1);
