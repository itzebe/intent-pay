# Status and settlement check (headless)

The smallest possible integration: no browser, no wallet, no UI. It holds the API
key on a server, reads an intent's status, and independently verifies settlement
on chain — the script a merchant's reconciliation job runs on a schedule.

It imports only `@intentpay/sdk` (the server entry point), so the API key stays
on the server by construction.

## Run it

```bash
# 1. Build the SDK (from the repo root)
npm --prefix packages/sdk install
npm --prefix packages/sdk run build

# 2. Read status only (safe, read-only)
INTENTPAY_API_KEY=ipk_live_… node examples/status-and-verify/check.mjs int_…

# 3. Record a broadcast hash and verify settlement
INTENTPAY_API_KEY=ipk_live_… node examples/status-and-verify/check.mjs int_… 0x…
```

Point it at a local deployment with `INTENTPAY_BASE_URL=http://localhost:3000`.

## What it shows

- `getIntent` / `getPaymentStatus` — the lifecycle, read without touching a wallet.
- `authorizeIntent` → `submitTransaction` → `verifySettlement` — the exact
  sequence a server runs after its customer's wallet reports the hash.
- The exit code is **non-zero unless settlement is `verified`**, so a cron job or
  CI step can depend on it. A `not_found`, `short` or `pending` verdict is never
  treated as paid.
