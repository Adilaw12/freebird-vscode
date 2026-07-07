# Deploying the OpenPilot Backend

Total time: ~20 minutes. Everything is free-tier friendly.

---

## 1. Upstash Redis (free, no credit card)

1. Go to [console.upstash.com](https://console.upstash.com) → sign up → **Create Database**
2. Name it `openpilot`, pick a region close to you, leave defaults → **Create**
3. Copy **REST URL** and **REST Token** from the database details page

---

## 2. Stripe

1. Go to [dashboard.stripe.com](https://dashboard.stripe.com) → sign up or log in
2. **Products → Add product**
   - Name: `OpenPilot Pro`
   - Price: `$6.00 / month` (recurring)
   - Click **Save product**
   - Copy the **Price ID** (starts with `price_`)
3. **Developers → API keys** → copy your **Secret key** (starts with `sk_live_` or `sk_test_` for testing)
4. **Developers → Webhooks → Add endpoint**
   - URL: `https://YOUR-VERCEL-URL.vercel.app/api/webhook`
   - Events to listen for:
     - `checkout.session.completed`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`
     - `invoice.payment_succeeded`
   - Copy the **Signing secret** (starts with `whsec_`)

---

## 3. Deploy to Vercel (free)

1. Push the `backend/` folder to a GitHub repository
   ```bash
   cd backend
   git init
   git add .
   git commit -m "Initial backend"
   git remote add origin https://github.com/YOUR-USERNAME/openpilot-backend
   git push -u origin main
   ```
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → import your `openpilot-backend` repo
3. In **Environment Variables**, add all values from `.env.example`:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRICE_ID`
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `APP_URL` (set to your Vercel deployment URL after first deploy)
4. Click **Deploy** → copy the deployment URL (e.g. `https://openpilot-backend.vercel.app`)

---

## 4. Create a Stripe Checkout (Payment Link — easiest)

1. In Stripe dashboard → **Payment Links → New**
2. Select your `OpenPilot Pro` product
3. Under **After payment**, set **Redirect URL** to:
   `https://YOUR-VERCEL-URL.vercel.app/api/success?session_id={CHECKOUT_SESSION_ID}`
4. Copy the Payment Link URL (e.g. `https://buy.stripe.com/...`)

---

## 6. GitHub sign-in (identity for the free tier)

The old free-tier quota was tracked by a self-reported machine ID, which
advanced users could bypass by resetting or spoofing it. As of v0.8.0, free
cloud edits are tracked per **verified GitHub account** instead.

1. Go to [github.com/settings/developers](https://github.com/settings/developers)
   → **OAuth Apps → New OAuth App**
2. Fill in any Application name/homepage URL/callback URL (device flow doesn't
   use the callback URL, but GitHub requires one — any valid URL works, e.g.
   your `ten-labs.com.au` homepage)
3. After creating it, check **"Enable Device Flow"** in the app settings
4. Copy the **Client ID** (no secret needed — device flow doesn't use it)
5. Open `src/auth/github.ts` and replace `GITHUB_CLIENT_ID` with that value
6. In Vercel → **Environment Variables**, add `AUTH_SECRET` — any long random
   string (e.g. `openssl rand -hex 32`). This signs the session tokens issued
   by `/api/auth-github`; keep it secret and never reuse it elsewhere.
7. Optional, once most users are on v0.8.0+: set `REQUIRE_AUTH=true` in Vercel
   to reject unauthenticated free-tier requests outright instead of falling
   back to the old machine-id scheme. Leave it unset/`false` during rollout.

---

## 7. Enterprise plan

Enterprise reuses the same license-key system as Pro but is priced
separately and tagged with its own plan value.

1. **Products → Add product** in Stripe: `Freebird Enterprise`, set your price
2. Copy its **Price ID**
3. In Vercel → **Environment Variables**, add `STRIPE_ENTERPRISE_PRICE_ID` set
   to that price ID
4. Create a Payment Link for it the same way as step 4 above
5. The webhook (`api/webhook.js`) automatically tags any checkout using that
   price ID as `plan: 'enterprise'` instead of `'pro'` — no other changes needed

Note: both Pro and Enterprise are now fully unmetered server-side (the old gap
where Pro users on the default cloud backend still hit the 20/day quota is
fixed) — the only difference between them is price and support tier.

---

## 8. Update the extension constants

Open `src/license/validator.ts` and update two lines:

```typescript
export const API_BASE    = 'https://YOUR-VERCEL-URL.vercel.app';
export const UPGRADE_URL = 'https://buy.stripe.com/YOUR-PAYMENT-LINK';
```

Then rebuild and republish the extension:
```bash
npm run compile
npx vsce publish
```

---

## Testing with Stripe test mode

1. Use `sk_test_...` key and a test Payment Link
2. Use test card: `4242 4242 4242 4242`, any future expiry, any CVC
3. After checkout, check Vercel logs and your Upstash database to confirm the license was stored

---

## Endpoints summary

| Endpoint | Purpose |
|---|---|
| `POST /api/validate` | Extension calls this to verify a license key |
| `POST /api/auth-github` | Verifies a GitHub access token, issues a signed session token |
| `POST /api/webhook` | Stripe calls this when subscriptions change |
| `GET /api/success?session_id=xxx` | Shows the license key after payment |
