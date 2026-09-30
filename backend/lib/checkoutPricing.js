// backend/lib/checkoutPricing.js — plan/cadence/country -> Stripe Price ID,
// shared by api/checkout.js. Extracted so the routing logic is unit-testable
// without a full Vercel handler (same reasoning as lib/quota.js).
//
// India gets its own PPP-priced INR Price rather than Stripe's Adaptive
// Pricing: Adaptive Pricing only does live mid-market FX conversion (no
// manual discount), and explicitly excludes UPI for cross-border
// subscriptions — confirmed against Stripe's own docs. A real INR Price is
// the only way to get both a PPP price and UPI in front of Indian buyers.
//
// STRIPE_PRICE_PRO_INDIA_* are deliberately allowed to be unset — until
// that Payment gets created in Stripe, Indian buyers fall through to the
// default (USD) price rather than getting a 500.

export const PLANS = ['pro'];

const PRICE_IDS = {
    pro: {
        default: {
            monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
            annual:  process.env.STRIPE_PRICE_PRO_ANNUAL,
        },
        india: {
            monthly: process.env.STRIPE_PRICE_PRO_INDIA_MONTHLY,
            annual:  process.env.STRIPE_PRICE_PRO_INDIA_ANNUAL,
        },
    },
};

/**
 * @param {string} plan
 * @param {'monthly'|'annual'} cadence
 * @param {string|null} country ISO 3166-1 alpha-2, from x-vercel-ip-country
 * @returns {{ priceId: string|undefined, region: 'default'|'india' }}
 */
export function priceIdFor(plan, cadence, country) {
    const planPrices = PRICE_IDS[plan];
    if (!planPrices) return { priceId: undefined, region: 'default' };

    const wantsIndia = country === 'IN';
    const indiaPriceId = wantsIndia ? planPrices.india?.[cadence] : undefined;

    // Falls through to the default (USD) price if the India Price isn't
    // configured yet, rather than failing the checkout outright.
    if (indiaPriceId) return { priceId: indiaPriceId, region: 'india' };
    return { priceId: planPrices.default?.[cadence], region: 'default' };
}

/**
 * Shared by api/checkout.js (JSON, used by the extension) and
 * api/upgrade-page.js (redirect, used by every plain link/markdown href —
 * including UPGRADE_URL itself) so the two entry points can never drift.
 *
 * @param {import('stripe').Stripe} stripe
 * @param {{ plan?: string, cadence?: 'monthly'|'annual', country: string|null, appUrl: string }} opts
 * @returns {Promise<{ session?: import('stripe').Stripe.Checkout.Session, error?: string, status?: number }>}
 */
export async function createCheckoutSession(stripe, opts) {
    const { plan = 'pro', cadence = 'monthly', country, appUrl } = opts;

    if (!PLANS.includes(plan)) return { error: `plan must be one of: ${PLANS.join(', ')}`, status: 400 };
    if (!['monthly', 'annual'].includes(cadence)) return { error: 'cadence must be "monthly" or "annual"', status: 400 };

    const { priceId, region } = priceIdFor(plan, cadence, country);
    if (!priceId) return { error: `Price not configured for ${plan}/${region}/${cadence}`, status: 500 };

    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:  `${appUrl}/upgrade`,
            // No payment_method_types override — left to Stripe's dashboard-
            // configured dynamic payment methods (UPI is enabled there for
            // INR), same as the Payment Links this replaces.
        });
        return { session };
    } catch (err) {
        console.error(`[checkout] Failed to create session (plan=${plan}, cadence=${cadence}, region=${region}):`, err.message);
        return { error: 'Failed to create checkout session', status: 500 };
    }
}
