# Merchant integration example

A **complete, independently runnable** merchant integration. It is what a third-party
application builds to accept an Intent Pay payment — it imports only the published contracts
and none of the Intent Pay application code.

| It uses | For |
| --- | --- |
| `@intentpay/sdk` | the keyed server client (create intent, checkout, verify, evidence) |
| `@intentpay/sdk/webhooks` | webhook signature verification |
| `GET /api/checkout/:token` (public) | the customer-facing order view |
| `https://…/checkout/:token` | the hosted customer checkout page |

It imports **no** Next.js component, no `lib/*` module and no `@/` alias. `server.mjs` holds the
API key; `public/index.html` is a plain page that calls the example's own server.

## Run it

```bash
# 1. Build the SDK (from the repo root)
npm --prefix packages/sdk install
npm --prefix packages/sdk run build

# 2. Create a merchant account and key (local deployment, or the admin token in production)
curl -s -X POST http://localhost:3000/api/v1/developers \
  -H 'Content-Type: application/json' -d '{"name":"my-shop"}'
# → { "developer": {…}, "apiKey": "ipk_test_…", … }   (shown once)

# 3. Run the example against a local or production deployment
INTENTPAY_API_KEY=ipk_test_… \
INTENTPAY_BASE_URL=http://localhost:3000 \
MERCHANT_RECIPIENT=0xYourMonadAddress \
node examples/merchant/server.mjs
```

Open <http://localhost:8790>.

## What each step demonstrates

1. **Merchant API authentication** — `GET /api/merchant/status` calls `pay.getAccount()`, proving
   the credential and returning the account and its key metadata (never a secret).
2. **Checkout-bound attribution** — `POST /api/merchant/attribution` registers a watch-only
   `xpub` via `pay.setAttribution(xpub)`; the panel then shows `checkout_bound` and a preview of
   the next derived destinations. Send `{"paymentXpub": null}` to fall back to `shared_recipient`.
3. **Checkout creation** — `POST /api/merchant/orders` creates an intent, validates it, then
   wraps it in a checkout with `pay.createCheckout({ intentId, orderReference, idempotencyKey })`.
4. **Payment-link generation** — the response carries `link` = `{baseUrl}/checkout/{token}`; it
   is safe to share (it carries no credential).
5. **Customer checkout access** — the order list reads the public `GET /api/checkout/:token`
   view, exactly as the hosted page does.
6. **Webhook signature verification** — `POST /api/webhook` verifies
   `X-IntentPay-Signature` over the **raw** body with `verifyWebhookSignature`. Register a URL
   pointing at this process with `POST /api/merchant/webhook` (use a tunnel for local testing).
7. **Payment status retrieval** — `pay.listCheckouts()` and the public view show the phase
   (`awaiting_payment` → `transaction_submitted` → `payment_verified`).
8. **Settlement evidence retrieval** — the per-order *evidence* button calls
   `pay.getCheckoutEvidence(id)`, which re-verifies the payment live and returns the settlement
   verdict, the transaction hashes, the frozen-parameter match and `settled`.

## The rule this example keeps

The API key stays in `server.mjs`. The browser talks only to this example's own server, and the
customer signs on the hosted page with their own wallet. The merchant credential can build and
verify a payment but can never authorize one.

## Notes

- Webhook delivery is asynchronous. Events enqueue and are drained by the deployment's
  scheduler, or manually via `POST /api/v1/webhooks/drain` (admin token). Local drains happen
  after the customer's submit/verify response.
- Secrets are shown once. This example keeps the webhook secret in memory; a real integration
  persists it in its own secret store.
