// backend/lib/xenditClient.js — thin wrapper around xendit-node's Payment
// Method (e-wallet tokenization) + Payment Request (charging a linked
// method) APIs — the recurring-billing building block Xendit provides.
// Unlike Stripe, it never auto-bills on its own; see xendit-recharge-cron.js.
//
// Verified against the actually-installed xendit-node@7.0.0 SDK's type
// definitions (node_modules/xendit-node/payment_method,payment_request) —
// NOT against Xendit's public docs alone, which mix an older "Payment
// Token" API generation (payment_token_id, payment_token.* webhook events)
// with the current "Payment Method" generation this SDK targets
// (paymentMethodId, payment_method.* events). If Xendit webhooks arrive
// with token-generation field/event names instead, see the defensive
// fallbacks in xendit-webhook.js and update both files together.

// Named import, not default — xendit-node's default export resolves to the
// wrong object at runtime (an `export * from './runtime'` re-export
// conflict makes `import Xendit from 'xendit-node'` bind to a non-callable
// object; verified against the actually-installed package, not just its
// .d.ts, which shows a default export that doesn't match runtime behavior).
import { Xendit } from 'xendit-node';

const client = new Xendit({ secretKey: process.env.XENDIT_SECRET_KEY });
const { PaymentMethod, PaymentRequest } = client;

// Creates an e-wallet payment method (tokenization request). Returns
// Xendit's raw response — callers read `.status` ('PENDING' expected while
// awaiting the customer's in-app authorization) and `.actions[].url` (where
// to redirect the customer to link their e-wallet).
export async function createPaymentToken({ referenceId, country, channelCode }) {
    return PaymentMethod.createPaymentMethod({
        data: {
            type: 'EWALLET',
            country,
            reusability: 'MULTIPLE_USE', // required for recurring re-charges
            referenceId,
            ewallet: {
                channelCode,
                channelProperties: {
                    successReturnUrl: `${process.env.APP_URL}/success?session_id=${referenceId}`,
                    failureReturnUrl: `${process.env.APP_URL}/pay-local?error=1`,
                },
            },
        },
    });
}

// Charges an already-ACTIVE payment method. Used both for the first charge
// (triggered by the webhook on activation) and every recurring charge
// (triggered by xendit-recharge-cron.js).
export async function createPaymentRequest({ referenceId, paymentMethodId, amount, currency }) {
    return PaymentRequest.createPaymentRequest({
        data: {
            referenceId,
            amount,
            currency,
            paymentMethodId,
        },
    });
}
