# Real-wallet validation runbook (Monad Mainnet)

This is the procedure for the **first funded, real-wallet payment** on Intent Pay.
It is deliberately split into what an agent has already verified (read-only) and
what only the owner can do (hold a funded key and approve in a real wallet).

The app is **Mainnet-only** — Monad, chain id **143**. There is no testnet or
fallback. Never execute a funded transaction while preparing a change; that is a
deliberate, owner-run step.

## What is already verified (no wallet, no funds)

These were confirmed against the production deployment, read-only:

| Check | Result |
| --- | --- |
| Production alias resolves to the deployed commit | `intent-pay-roan.vercel.app` → sha `ef07fea`, `READY` |
| Wallet discovery is advertised | `/api/capabilities` → `wallets.injected.eip6963 = true`, `legacyInjected = true` |
| WalletConnect is configured | `wallets.walletConnect.configured = true` |
| WalletConnect can reach its relay in production | CSP `connect-src` includes `wss://relay.walletconnect.com`; QR iframe allowed in `frame-src` |
| Live routing works | `POST /api/quote` (USDT → USDC, 5 USDC out) returns a real pool route |
| Balances read the real chain | `GET /api/balances?address=…` returns on-chain balances |

Automated coverage is **mocked** and proves the *rules*, not a real wallet:
`tests/walletIntegration.test.tsx`, `tests/walletDiscovery.test.ts`,
`tests/walletConnect.test.ts`, `tests/checkoutSwapOrdering.test.tsx`,
`tests/sendCalls.test.ts`. A green suite is necessary, not sufficient.

## What only the owner can do (funded)

Use a wallet you control with a **small** amount of MON. MetaMask, Rabby,
Coinbase Wallet or Trust Wallet all work; the app discovers any EIP-1193 wallet
via EIP-6963 (with a legacy `window.ethereum` fallback).

### Step 1 — connect and confirm identity

1. Open https://intent-pay-roan.vercel.app in a browser with the wallet installed.
2. Click **Connect wallet**. Confirm the wallet you expect is listed.
3. Approve account access. Check the header shows **your real address** and your
   **real MON balance**.
4. If the wallet is not on Monad, the app switches it to chain id 143 — approve
   the network switch. The header must read Mainnet.

### Step 2 — the smallest safe payment

Prefer the **composer** for the first run: a single native-MON transfer is one
transaction and the simplest path.

1. Enter a recipient you control (a second address), choose **MON**, and enter a
   tiny amount (for example `0.001`).
2. Review. Confirm the review shows the recipient, the amount, the network cost,
   and **Gas: native MON**. There is no sponsorship or gasless mode.
3. Approve in the wallet. The app waits for the receipt before reporting anything.
4. **Success requires proof.** The success screen reads "delivered" only when
   `verifyDelivery` proves the recipient's transfer on-chain. "Sent / broadcast,
   delivery not yet proven" is not success.

### Step 3 — a swap payment (the multi-step case)

A payment where the recipient receives a different asset than you spend is
several sequential transactions (approve → swap → unwrap → deliver). Each must be
mined before the next is valid.

1. Ask for **USDC** and pay with **MON** (or any funded asset).
2. Watch the wallet: you should be prompted for each transaction **in turn**, and
   the next prompt must not appear until the previous transaction is confirmed.
3. Verify the recipient received the exact requested USDC amount.

If a step reverts, the app stops and shows the real reason — it never silently
continues or resubmits.

### Step 4 — merchant checkout (optional)

The hosted checkout page (`/checkout/:token`) uses the same rule. To exercise it
you need a merchant API key and a created checkout (see `/docs/checkout`).

## Recording the evidence

For each real payment, capture:

- the transaction hash(es), and the MonadScan link `https://monadscan.com/tx/<hash>`;
- the receiving address and the exact amount received;
- the `/verify` verdict (`verified` is the only pass; `short`, `reverted`,
  `pending`, `not_found` are honest non-passes);
- the wallet name and version, and the browser.

Do not claim a verified payment from a broadcast alone. The repository's own rule
is that a broadcast is not a success until the on-chain delivery is proven.

## Known blockers and limits

- **WalletConnect needs a project id.** It is configured in production
  (`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, from https://dashboard.reown.com).
  Without it the option is shown as unavailable and injected wallets still work.
- **No MEV-protected submission.** `resolveMevProtection` always returns
  `MEV_PROTECTION_UNAVAILABLE`. Protection relies on on-chain slippage bounds, a
  price-impact guard, quote freshness and on-chain delivery verification. The
  review sheet never shows an "Active" MEV badge.
- **Gas is always native MON.** A wallet with no MON is blocked with an explicit
  reason; there is no paymaster or sponsorship path.
- **Zerion is best-effort.** A configured-but-failing Zerion means the wallet's
  holdings are *unknown*, not empty; execution never depends on it.
