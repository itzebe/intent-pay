# Developer opportunities

How a builder can integrate Intent Pay today, and what is honestly not available
yet.

## What is available now

- **Versioned HTTP API** at `/api/v1` (bearer API key). Stateless; no session.
- **TypeScript SDK** `@intentpay/sdk` — built from this repository, **not yet on
  npm** (see `readiness.md`).
- **Webhooks** with HMAC-SHA256 signatures.
- **Idempotency keys** on intent creation (a retry returns the same intent).
- **Independent settlement verification** — the server reads the Monad receipt
  itself; a client can also call the verify endpoint.

## The lifecycle as an API

```
POST /api/v1/intents                  create the payment intent
POST /api/v1/intents/{id}/validate    recipient, asset, chain, amount
POST /api/v1/intents/{id}/prepare     build the wallet calls (nothing is sent)
POST /api/v1/intents/{id}/authorize   freeze the parameters before signing
POST /api/v1/intents/{id}/submit      record the broadcast transaction hash(es)
POST /api/v1/intents/{id}/verify      verify settlement on-chain — the only "paid"
```

Checkouts wrap an intent for a merchant: create, prepare-for-customer, submit,
verify, cancel, and `GET .../evidence` for the settlement proof.

## Integration shapes

1. **Server-side create, client-side sign.** Your server holds the API key and
   creates the intent; the user's wallet (browser or SDK `Wallet`) signs. The key
   never reaches the browser — the SDK refuses to build a keyed client in one.
2. **Hosted checkout.** Create a checkout and send the customer to
   `/checkout/{token}`; you keep your own order record and read status by API.
3. **Headless merchant.** Use the SDK from a script/backend for the merchant
   half (create -> checkout -> verify), as `examples/merchant-onboarding/demo.mjs`
   does.

## What a builder gets from the capabilities endpoint

`GET /api/v1/capabilities` advertises **only implemented** capabilities: the real
chain (143), the endpoint list, the shipped assets, the intent and checkout
states, the webhook events, and the store's durability. It is the machine-
readable honesty surface — read it first.

## Honest gaps a builder should plan around

- **No sandbox or testnet.** Development against production is real mainnet
  value. Plan for that; there is no simulated ledger.
- **No refunds.** Reconciliation of an overpayment is manual.
- **No self-service signup.** Production credentials are operator-provisioned.
- **Request-driven webhooks.** Add a scheduled drain for reliability.
- **SDK not on npm.** Install from the built tarball until it is published.

## Where to start

- `docs/quickstart.md` and `/docs/quickstart` — authenticate, create, prepare,
  submit, verify.
- `examples/merchant-onboarding/` — a runnable, signature-free lifecycle demo.
- `docs/developers.md` and `/docs/developers` — repository layout and commands.
