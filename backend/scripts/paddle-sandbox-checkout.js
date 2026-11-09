// scripts/paddle-sandbox-checkout.js — creates a Paddle sandbox checkout for one
// price and prints its link, so a test purchase can be made without a payment
// link in the dashboard.
//
// Usage (sandbox key only, never the live key):
//   PADDLE_SANDBOX_API_KEY=... node scripts/paddle-sandbox-checkout.js pri_xxx
//
// The link goes to a Paddle-hosted checkout. Use a test card from Paddle's
// sandbox docs. Keep the key in your shell, not in files.

const apiKey = process.env.PADDLE_SANDBOX_API_KEY;
const priceId = process.argv[2];

if (!apiKey || !priceId) {
    console.error('Usage: PADDLE_SANDBOX_API_KEY=... node scripts/paddle-sandbox-checkout.js pri_xxx');
    process.exit(1);
}

const res = await fetch('https://sandbox-api.paddle.com/transactions', {
    method: 'POST',
    headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: 'automatic'
    })
});

const body = await res.json().catch(() => ({}));
const url = body?.data?.checkout?.url;

if (!res.ok || !url) {
    console.error(`Paddle returned ${res.status}:`, JSON.stringify(body, null, 2));
    process.exit(1);
}

console.log('Open this link in a private window to make the test purchase:');
console.log(url);
