// backend/lib/xenditPricing.js — per-country plan config for the Xendit
// "local methods" checkout. v1 scope: Pro plan only (no enterprise/team/
// templates), Vietnam + Indonesia only.
//
// IDR/VND have no minor unit — amounts below are whole integers, unlike
// Stripe's cents. Defaults are a rough $6/month equivalent — THESE ARE
// PLACEHOLDERS, not a pricing decision. Override via XENDIT_PRICE_IDR /
// XENDIT_PRICE_VND before launch.
//
// QRIS is deliberately NOT included here even though it's Indonesia's most
// dominant online payment rail — verified against the actual installed
// xendit-node SDK that QRIS is a `QR_CODE` PaymentMethodType with its own
// QRCodeParameters shape, structurally different from the EWALLET
// tokenize-then-charge flow this integration builds (lib/xenditClient.js).
// Adding QRIS support is a real, separate follow-up, not an oversight.
export const XENDIT_PLANS = {
    ID: {
        country: 'ID',
        currency: 'IDR',
        amount: Number(process.env.XENDIT_PRICE_IDR ?? 95000),
        channels: ['OVO', 'DANA', 'SHOPEEPAY'],
    },
    VN: {
        country: 'VN',
        currency: 'VND',
        amount: Number(process.env.XENDIT_PRICE_VND ?? 149000),
        channels: ['MOMO', 'ZALOPAY'],
    },
};

// Never trust a client-supplied country/channel pair without checking it
// against this whitelist first — see xendit-checkout.js.
export function resolvePlan(country, channelCode) {
    const plan = XENDIT_PLANS[country];
    if (!plan || !plan.channels.includes(channelCode)) return null;
    return plan;
}
