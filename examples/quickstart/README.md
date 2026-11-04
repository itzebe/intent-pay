# Intent Pay SDK — quickstart

A runnable example of the correct split: **the server holds the API key, the browser holds the
wallet.**

## Run it

```bash
# 1. Build the SDK (from the repo root)
npm --prefix packages/sdk install
npm --prefix packages/sdk run build

# 2. Start the example
INTENTPAY_API_KEY=ipk_live_… node examples/quickstart/server.mjs
```

Open <http://localhost:8787>, connect a wallet, and pay.

## What it shows

- `server.mjs` — creates, validates and prepares an intent with the keyed client, then records
  and verifies the hashes the wallet produced. Every credential-bearing call is here.
- `public/index.html` — discovers wallets (EIP-6963), connects, enforces Monad, and calls
  `wallet.sendCalls(prepared.calls)`. It imports **only** `@intentpay/sdk/wallet`, so the API
  key can never reach the page.

Point it at a local deployment with `INTENTPAY_BASE_URL=http://localhost:3000`.

> The example serves the built SDK from `packages/sdk/dist` for simplicity. In a real
> application you would import `@intentpay/sdk/wallet` through your bundler instead.
