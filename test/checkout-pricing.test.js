// test/checkout-pricing.test.js — plan/cadence/country -> Price ID routing
// (backend/lib/checkoutPricing.js). Pure logic, no network/Stripe calls.

const path = require('path');
const { suite, check, summary } = require('./helpers');

async function run() {
    const modPath = path.join(__dirname, '..', 'backend', 'lib', 'checkoutPricing.js');

    suite('default (non-India) region resolves the USD prices');
    {
        process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_monthly_usd';
        process.env.STRIPE_PRICE_PRO_ANNUAL  = 'price_annual_usd';
        delete process.env.STRIPE_PRICE_PRO_INDIA_MONTHLY;
        delete process.env.STRIPE_PRICE_PRO_INDIA_ANNUAL;
        const { priceIdFor } = await import(`file://${modPath}?t=${Date.now()}-1`);

        const monthly = priceIdFor('pro', 'monthly', 'US');
        check('US monthly resolves the USD monthly price', monthly.priceId === 'price_monthly_usd');
        check('US monthly region is "default"', monthly.region === 'default');

        const annual = priceIdFor('pro', 'annual', 'GB');
        check('GB annual resolves the USD annual price', annual.priceId === 'price_annual_usd');

        const noCountry = priceIdFor('pro', 'monthly', null);
        check('missing country falls back to default region', noCountry.priceId === 'price_monthly_usd');
    }

    suite('India resolves its own INR prices when configured');
    {
        process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_monthly_usd';
        process.env.STRIPE_PRICE_PRO_ANNUAL  = 'price_annual_usd';
        process.env.STRIPE_PRICE_PRO_INDIA_MONTHLY = 'price_monthly_inr';
        process.env.STRIPE_PRICE_PRO_INDIA_ANNUAL  = 'price_annual_inr';
        const { priceIdFor } = await import(`file://${modPath}?t=${Date.now()}-2`);

        const monthly = priceIdFor('pro', 'monthly', 'IN');
        check('IN monthly resolves the INR monthly price', monthly.priceId === 'price_monthly_inr');
        check('IN monthly region is "india"', monthly.region === 'india');

        const annual = priceIdFor('pro', 'annual', 'IN');
        check('IN annual resolves the INR annual price', annual.priceId === 'price_annual_inr');

        const nonIndia = priceIdFor('pro', 'monthly', 'US');
        check('a non-IN country is unaffected by India prices being configured', nonIndia.priceId === 'price_monthly_usd');
    }

    suite('India falls through to the default price when the INR price is not configured yet');
    {
        process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_monthly_usd';
        process.env.STRIPE_PRICE_PRO_ANNUAL  = 'price_annual_usd';
        delete process.env.STRIPE_PRICE_PRO_INDIA_MONTHLY;
        delete process.env.STRIPE_PRICE_PRO_INDIA_ANNUAL;
        const { priceIdFor } = await import(`file://${modPath}?t=${Date.now()}-3`);

        const result = priceIdFor('pro', 'monthly', 'IN');
        check('IN falls back to the USD price rather than failing', result.priceId === 'price_monthly_usd');
        check('fallback is reported as region "default", not silently claiming "india"', result.region === 'default');
    }

    suite('unknown plan/cadence resolve to no price rather than throwing');
    {
        const { priceIdFor } = await import(`file://${modPath}?t=${Date.now()}-4`);
        const badPlan = priceIdFor('nonexistent-plan', 'monthly', 'US');
        check('unknown plan returns undefined priceId (not a throw)', badPlan.priceId === undefined);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => process.exit(summary() ? 0 : 1));
}
