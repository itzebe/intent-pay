# Product

## What the product does

Intent Pay turns a payment intention into a verified on-chain payment. The user
supplies three things — recipient, amount, and the token the recipient should
receive — and the system resolves the source asset, the route and the
transaction. The user authorizes it in their own wallet.

Two intent modes:

- **Recipient receives** (default) — the user fixes what the recipient gets; the
  app prices what the user spends.
- **I spend** — the user fixes what they spend; the app shows what the recipient
  receives.

A natural-language bar offers the same flow: `Send $10 worth of MON to 0x…`,
`Send 10 MON`, or `Send $10`. Parsing is deterministic and offline; an optional
LLM may only fill gaps and can never supply a price, route, address or
transaction.

## Individual journey

1. **Connect a wallet.** EIP-6963 injected-wallet discovery (MetaMask, Rabby,
   Coinbase, Trust Wallet, …) with a legacy fallback, plus WalletConnect mobile
   and QR wallets when a project id is configured. The app switches the wallet to
   Monad Mainnet (chain id 143) before signing.
2. **State the intent.** Recipient, amount, receive token — by form or in plain
   English.
3. **Review the route.** The app reads real balances, prices assets, finds
   routes, and recommends the best funded source with a plain-language reason.
   Advanced routing detail is hidden behind an expander.
4. **Authorize once.** The signing guard rebuilds everything from fresh data
   immediately before signing and refuses on any change. The user approves a
   single prepared transaction in their wallet.
5. **Verify settlement.** The recipient's on-chain transfer is proven from the
   confirmed receipt against the minimum the transaction enforced.

## Developer journey

1. **Get an API key** and read `GET /api/v1/capabilities` — the machine-readable
   statement of the real chain, endpoints, assets, intent states and webhook
   events.
2. **Create an intent** (`POST /api/v1/intents`) — recipient, receive token and a
   USD amount. A retry with the same idempotency key returns the same intent.
3. **Validate** (`POST /api/v1/intents/{id}/validate`) — recipient, asset, route
   and liquidity.
4. **Prepare** (`POST /api/v1/intents/{id}/prepare`) — build the wallet calls.
   Nothing is signed or sent on the server.
5. **Submit and verify** — after the wallet broadcasts, record the hash(es) and
   call `verify` to prove settlement on-chain.

See [developers.md](./developers.md) and the in-app `/docs/api` reference.

## Merchant journey

1. **Create an intent** for the amount and asset you want to receive.
2. **Create a checkout** (`POST /api/v1/checkouts`) — this freezes the intent and
   returns a public `chk_…` payment-link handle. Optionally register a watch-only
   xpub so each order is paid to a unique derived destination.
3. **Share the link or QR.** The customer opens `/checkout/<token>` and pays with
   their own wallet; the page carries no credential.
4. **Watch settlement.** The order reaches `payment_verified` only when `/verify`
   proves the recipient's transfer from the Monad receipt. A broadcast is shown as
   "Confirming", never "paid".

See [merchants.md](./merchants.md) and the in-app `/docs/checkout` guide.

## Capabilities

### Payment execution — COMPLETE

- Live Monad Mainnet integration (chain id 143).
- Multi-wallet connectivity: EIP-6963 discovery, legacy fallback, WalletConnect.
- App-owned transaction preparation (gas, EIP-1559 fees, nonce) so a wallet never
  has to read its own node to build the envelope.
- Exactly-once submission — a single approval maps to a single broadcast; the
  submission is never retried.
- On-chain output bounds on every swap step (exact-in `amountOutMinimum`,
  exact-out `amountInMaximum`).
- A signing guard that rebuilds from fresh data and refuses on any change.
- Delivery verification from the confirmed receipt.
- Partial-balance split: send what you hold and convert the shortfall, each leg
  with its own bound.
- Evidence-based recovery for an ambiguous submission outcome.

### Developer infrastructure — COMPLETE

- Versioned `/api/v1` HTTP API: intents, checkouts, webhooks, attribution and
  capabilities.
- TypeScript SDK (`@intentpay/sdk`) with a server client, a browser wallet layer
  and webhook signature verification.
- Typed errors with `isRetryable` and `isAmbiguousSubmission` predicates.
- Runnable examples under `examples/`.

### Merchant infrastructure — COMPLETE

- Hosted checkout page at `/checkout/<token>`.
- Payment links and QR codes.
- Exact-asset settlement verification.
- Per-order attribution via a watch-only xpub.
- Webhooks for checkout and payment events.
- A merchant console that is a real client of the public API.

## Current limitations

- **Monad only.** Not a bridge; no cross-chain delivery.
- **Gas is always MON.** No sponsored, ERC-20 or account-abstracted gas path.
- **No service fee** is charged today; fee collection is planned and would be
  disclosed before authorization.
- **Long-tail route coverage** keeps expanding; an asset with no liquidity fails
  honestly with `route_unavailable`.
- **Real-device wallet coverage** — additional physical-device testing is
  outstanding (see [roadmap.md](./roadmap.md)).
