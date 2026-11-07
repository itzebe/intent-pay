# Intent Pay — technical overview

An intent-based payment layer on Monad Mainnet (chain id 143). A user states
what the recipient should receive — recipient, amount, token — and the system
works out which asset the sender spends, the route, and the transaction. The
user approves that transaction in their own wallet; settlement is verified
on-chain.

This document is written for a Monad ecosystem reviewer. Every claim maps to
code in the repository or to a live, observable behaviour. Implemented and
planned functionality are labelled separately at the end.

## Problem

On-chain payments assume the sender already holds the exact asset the recipient
wants. When they do not, the user is pushed into a swap interface: pick a pair,
pick a fee tier, reason about slippage, approve, swap, then send. The payment
itself — *this recipient receives this amount of this token* — is lost inside a
trading workflow, and the amount that lands is not the amount that was meant.

Intent Pay puts the payment back at the centre. The user expresses an outcome;
the system resolves the routing, the slippage bound and the calldata as
machinery the user should not have to reason about.

## Product architecture

```
  Individual user / Merchant customer / Developer integration
                          |
                          v
             +--------------------------+
             |  Intent Pay frontend      |  Next.js 15 + TypeScript
             |  composer - checkout      |  (non-custodial)
             +-----------+--------------+
                         |  HTTPS (JSON)
             +-----------v--------------+
             |  /api/v1  (bearer key)    |  stateless server functions
             |  /api/checkout (token)    |  per-request, no session
             +-----------+--------------+
        +----------------+-------------------------+
        v                v                          v
   Intent model     Routing (Uniswap V3)      Settlement verification
   lib/domain       lib/providers             lib/execution/verify.ts
        |                |                          |
        +----------------+-----------+--------------+
                                     v
                        +-----------------------+
                        |  User's own wallet    |  EIP-6963 / WalletConnect
                        |  authorizes + signs   |  (keys never leave it)
                        +-----------+-----------+
                                    v
                        +-----------------------+
                        |   Monad Mainnet 143   |  EVM, Uniswap V3, ~0.3s blocks
                        +-----------+-----------+
                                    v
                        Confirmed receipt -> verified delivery
                                    |
                                    v
                        Merchant outcome + webhook delivery
```

See `technical-architecture.md` for the layered detail.

## Payment-intent model

A **payment intent** is the canonical state: recipient, the amount, the token
the recipient receives, and how the amount is measured. It is created once and
carried through every stage. `lib/domain/canonicalIntent.ts` is the single
source of truth; the composer, the checkout, the quote, the plan and the signing
guard all read it, so the views cannot drift.

- Amounts are stated in USD by default; `amountMode` chooses whether the value
  is measured on the recipient side or the sender side.
- A token-quantity intent (`send 100 TOKEN`) names what the recipient receives;
  it does not silently fix the source asset.

## Wallet authorization

Authorization always happens in the user's own wallet. Intent Pay never asks for
a seed phrase or private key, holds no key, and never signs on the user's behalf.

- Discovery is EIP-6963 with a legacy `window.ethereum` fallback, plus
  WalletConnect (mobile/QR) when configured.
- `prepareSigning` (`lib/execution/signGuard.ts`) is the only path to a
  signature. Immediately before signing it fetches fresh balances and a fresh
  quote, re-reads the canonical intent and the wallet account, re-checks
  freshness, price impact and coverage, and rebuilds the calldata. Any change
  aborts with a specific reason.
- A transaction submission is **never retried**. One approval maps to one
  broadcast.

## Monad integration

- **Network:** Monad Mainnet, chain id 143. Mainnet only — there is no testnet
  or fallback network in the product.
- **Routing:** live Uniswap V3 exact-output and exact-input quoting across every
  fee tier (`lib/providers/uniswapV3.ts`), through `getRoutingProvider`.
- **Chain reads:** Intent Pay reads the chain through its own HTTPS RPC clients
  (with a fallback transport ending at the key-free public `rpc.monad.xyz`). The
  wallet is asked only to authorize and broadcast.
- **Gas:** always paid in native MON by the user's own injected wallet. There is
  no paymaster, bundler, UserOperation or ERC-20-gas path.

## Transaction preparation

`lib/execution/plan.ts` builds the step list (approve → swap → unwrap →
deliver), and `lib/server/quote.ts` prices the quote's gas limit from the
**whole plan**, not a single transaction. Every swap step carries a real on-chain
output bound (`amountOutMinimum` / `amountInMaximum`) derived from a clamped
slippage tolerance (default 50 bps, hard ceiling 500 bps).

## Transaction submission

`lib/execution/execute.ts` submits one step at a time through the user's wallet
and waits for each receipt before sending the next. `confirmed` is true only when
**every** step reached a successful receipt; an unobserved receipt is reported
`unconfirmed` with its hash kept, and the remaining steps are not run.

## Settlement verification

`verifyDelivery` (`lib/execution/verify.ts`) proves the recipient's actual
on-chain transfer from the confirmed receipt, against the minimum the transaction
enforced. A reverted transaction is failed; an unprovable delivery is shown as
unverified — never as success. The API exposes the same proof at
`POST /api/v1/intents/{id}/verify` and `GET /api/v1/checkouts/{id}/evidence`.

## Developer integration

A versioned HTTP API (`/api/v1`) and a TypeScript SDK (`@intentpay/sdk`, built
in this repository, not yet on npm). Five calls mirror the five stages: create,
validate, prepare, authorize/submit, verify. Webhooks carry signed events with
HMAC-SHA256.

## Merchant workflows

A merchant creates an intent, wraps it in a checkout, and shares a payment link
or QR. The customer pays with their own wallet; the merchant receives the asset
they asked for. A merchant who registers a watch-only payment xpub gets a unique
destination per checkout (checkout-bound attribution); without one, checkouts
share the merchant's recipient.

## Security boundaries

- Non-custodial: no private-key custody anywhere; a credential can prepare a
  transaction but can never sign or send one (`credentialCanSign: false`).
- The server holds no per-user session; every handler is a stateless function of
  its request body. Caches are keyed by user-supplied identity.
- External token metadata is not authoritative: `resolveByAddress` re-reads
  `decimals()`/`symbol()` on chain before a token can be spent.
- Raw upstream errors are never returned to a client (`sanitizeUpstreamError`).
- No third-party script origins in the CSP; `connect-src` is `'self'` plus the
  browser RPC origins.

## Existing limitations (honest)

- **Monad only.** Not a bridge; no cross-chain delivery is claimed.
- **No refunds.** No refund endpoint exists; an overpayment is never refunded
  automatically.
- **No sandbox.** There is no testnet or simulated-ledger mode; a `test` key does
  not change the chain.
- **Operator-gated signup.** Production credentials are provisioned by the
  operator; there is no self-service merchant signup.
- **Request-driven webhooks.** Delivery is request-driven; a production merchant
  should add a scheduled drain.
- **Live-route coverage** for the long tail of tokens keeps expanding.
- **SDK not published.** The package builds and packs cleanly but is not on npm.

## Future development opportunities

- Self-service merchant onboarding with a review step.
- A scheduled webhook drain and delivery retries with backoff.
- Expanded live-route coverage and additional quote sources.
- A transparent service fee with on-screen disclosure before authorization
  (planned, not operational).
- npm publication of `@intentpay/sdk` once the npm scope is held by the owner.

## Implemented vs planned

| Area | Status |
| --- | --- |
| Intent model, routing, execution, verification | Implemented |
| Wallet discovery (EIP-6963, legacy, WalletConnect) | Implemented |
| Developer API + SDK (built from source) | Implemented |
| Hosted checkout, payment links, QR | Implemented |
| HMAC webhooks, idempotency, replay protection | Implemented |
| Merchant console | Implemented |
| Refunds | Planned |
| Scheduled webhook drain | Planned |
| Sandbox / testnet mode | Not planned as a claim (mainnet only) |
| Self-service production signup | Planned |
| `@intentpay/sdk` on npm | Blocked (scope ownership) |
| Service fee | Planned |
