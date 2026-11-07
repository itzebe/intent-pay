# Merchant onboarding demonstration

A **headless** run of the real merchant lifecycle against a deployment. It proves
the integration surface end to end — capabilities → intent → checkout → payment
link → prepare → submit → verify — with no browser and **no signature**, so it is
safe to run at any time and moves no funds.

It imports only the published SDK server entry point (`@intentpay/sdk`); it holds
no application code, no `@/` alias and no `lib/*` import.

## Run it

```bash
# 1. Build the SDK (from the repo root)
npm --prefix packages/sdk install
npm --prefix packages/sdk run build

# 2. Get a merchant key (open locally; operator-gated in production — see docs/merchants.md §6)
curl -s -X POST http://localhost:3000/api/v1/developers \
  -H 'Content-Type: application/json' -d '{"name":"my-shop"}'
# → { "developer": {…}, "apiKey": "ipk_test_…" }   (shown once)

# 3. Run the demo against a local or production deployment
INTENTPAY_API_KEY=ipk_test_… \
INTENTPAY_BASE_URL=http://localhost:3000 \
node examples/merchant-onboarding/demo.mjs
```

## What it demonstrates

| Step | Call | What it proves |
| --- | --- | --- |
| Capabilities | `pay.getCapabilities()` | the real chain, assets and endpoints |
| Account | `pay.getAccount()` | the credential authenticates; no secret returned |
| Create | `pay.createIntent(...)` | a payment intent is created |
| Validate | `pay.validateIntent(id)` | the recipient, asset and route are real |
| Checkout | `pay.createCheckout(...)` | a payable order and a payment link |
| Prepare | `pay.prepareCheckout(id, {sender})` | real calldata, built but **never signed** |
| Verify | `pay.verifyCheckout(id)` | settlement is proven on-chain, or reported honestly |

## The rule this demo keeps

It **never signs and never broadcasts**, and it never reports a payment unless the
server's independent verification returns `verified`.

- With no `DEMO_TX_HASH`, it proves the merchant half and exits `0`, stating
  plainly that settlement still requires a real customer payment.
- With a real `DEMO_TX_HASH` (from a customer's wallet), it records and verifies
  it. A verdict other than `verified` prints "Do not treat this as paid" and exits
  non-zero.

There is **no sandbox** — Intent Pay is Monad mainnet only. A real payment moves
real funds; see `docs/merchants.md` §15.

## Env

| Variable | Default | Meaning |
| --- | --- | --- |
| `INTENTPAY_API_KEY` | — | required merchant API key |
| `INTENTPAY_BASE_URL` | `https://intent-pay-roan.vercel.app` | the deployment to run against |
| `MERCHANT_RECIPIENT` | a documented placeholder | the receive address |
| `DEMO_AMOUNT_USD` | `1` | the amount to request |
| `DEMO_SENDER` | a documented placeholder | used only to **build** calldata |
| `DEMO_TX_HASH` | — | a real hash to record and verify |
