# Roadmap

This roadmap reflects the repository and its Git history. It carries no promised
dates, no invented commitments, and no partnerships. Status categories:

- **COMPLETE** — implemented, tested and exercised against Monad Mainnet.
- **IN PROGRESS** — partly implemented; usable but not finished.
- **PLANNED** — designed or intended, not implemented.
- **BLOCKED** — cannot proceed without an external dependency.
- **NEEDS VALIDATION** — implemented, but a specific real-world check has not yet
  been performed.

## Latest milestone — owner-confirmed payment acceptance

**COMPLETE.** After PR #49 (merge `a454a35`), the project owner reported that a
**real payment successfully completed** through Intent Pay. This is recorded as
*owner-confirmed physical payment acceptance*: the owner confirmed the outcome,
and the fix that enabled it (removing a duplicate-submission retry) is covered by
regression tests and verified in production. No transaction hash, amount, merchant
identity or independently verified on-chain record is asserted here, because none
was supplied for publication.

## Payment execution and reliability

| Status | Milestone | Evidence |
| --- | --- | --- |
| COMPLETE | Monad Mainnet integration (chain id 143) | `lib/config/chains.ts` |
| COMPLETE | Multi-wallet connection and provider discovery (EIP-6963 + legacy fallback) | PR #20 (`eaf7ea9`), `lib/wallet/eip6963.ts` |
| COMPLETE | WalletConnect mobile / QR wallets (config-gated) | PR #20, `lib/wallet/walletconnect.ts` |
| COMPLETE | Trust Wallet integration | PRs #36–#48, `lib/wallet/*` |
| COMPLETE | App-owned transaction preparation (gas, fees, nonce) | PR #46 (`3a9ecde`), `lib/execution/prepareTx.ts` |
| COMPLETE | Explicit wallet transaction submission | `lib/execution/execute.ts`, `lib/wallet/sendTransaction.ts` |
| COMPLETE | Exactly-once submission invariant (`retryCount: 0`) | PR #49 (`a454a35`), `lib/wallet/sendTransaction.ts` |
| COMPLETE | Evidence-based ambiguous-submission recovery | PR #47 (`67952ae`), PR #48 (`af06fad`) |
| COMPLETE | Payment composer and hosted checkout resilience | PRs #33, #35, #47, #48 |
| COMPLETE | Transaction receipt and settlement verification | `lib/execution/verify.ts`, PR #32 (`705e0e9`) |
| COMPLETE | Partial-balance split with per-leg bounds | `lib/domain/partialBalance.ts`, `lib/server/partial.ts` |
| COMPLETE | RPC failover and app-owned RPC recovery | PRs #37 (`8472a73`), #43 (`a066c6e`), #45 (`db73fe8`) |
| COMPLETE | Live Uniswap V3 routing (every fee tier, exact-in/out) | `lib/providers/uniswapV3.ts` |

## Developer infrastructure

| Status | Milestone | Evidence |
| --- | --- | --- |
| COMPLETE | Versioned external developer API v1 | PR #21 (`af49c4a`), `app/api/v1/*` |
| COMPLETE | TypeScript SDK (`@intentpay/sdk`) | PR #22 (`2e61e4d`), `packages/sdk` |
| COMPLETE | Typed SDK error handling and transaction execution | `packages/sdk/src/core/errors.ts`, `src/wallet/connect.ts` |
| COMPLETE | Webhooks with signature verification | PRs #24, #30, #31, `lib/developer/webhooks.ts` |
| COMPLETE | Runnable integration examples | `examples/quickstart`, `examples/merchant`, `examples/status-and-verify`, `examples/merchant-onboarding` |
| COMPLETE | Developer documentation (in-app and repository) | `/docs/api`, `/docs/developers`, `docs/*` |
| NEEDS VALIDATION | External developer onboarding and integration validation | No third-party integration has been validated end to end yet |
| BLOCKED | SDK publication to npm | The package (`@intentpay/sdk`) builds and packs (LICENSE now included) but is not published; publishing needs an npm account/scope the repository does not hold |

## Merchant infrastructure

| Status | Milestone | Evidence |
| --- | --- | --- |
| COMPLETE | Merchant checkout over the v1 API | PR #23 (`bc7c4f8`), `app/api/v1/checkouts/*` |
| COMPLETE | Hosted checkout page and payment links | `app/checkout/[token]`, PR #33 |
| COMPLETE | Payment QR codes | `components/checkout/PaymentQR.tsx` |
| COMPLETE | Per-order attribution via watch-only xpub | PRs #26 (`5d5f4ba`), #29 (`82185a6`) |
| COMPLETE | Replay-resistant settlement attribution | PR #25 (`2253abd`) |
| COMPLETE | Payment status and independent verification | `lib/server/*`, checkout `/verify` routes |
| COMPLETE | Merchant console (real client of the public API) | `components/merchant/MerchantConsole.tsx` |
| COMPLETE | Merchant onboarding journey (landing page + guide) | `app/merchants/page.tsx`, `docs/merchants.md`, regression `tests/merchantOnboarding.test.ts` |
| COMPLETE | Headless merchant demonstration (no signature) | `examples/merchant-onboarding` |
| NEEDS VALIDATION | Merchant onboarding usability | The console works and the headless demo proves the merchant half; a real merchant has not yet completed a live order |
| PLANNED | Refunds | No refund endpoint exists; an overpayment is never refunded automatically |
| PLANNED | Scheduled webhook drain | Delivery is request-driven today; a production merchant should add a cron drain (`docs/merchants.md` §12) |

## Security and hardening

| Status | Milestone | Evidence |
| --- | --- | --- |
| COMPLETE | Security headers and scoped CSP | PR #14 (`25e22b8`), `next.config.mjs` |
| COMPLETE | Durable referral storage and honest storage capability | PR #17 (`cadc326`), `lib/store/*` |
| COMPLETE | Patched runtime and dependency floors | PR #15, `package.json` `engines`/`overrides` |
| COMPLETE | Non-custodial execution and signing guard | `lib/execution/signGuard.ts` |
| COMPLETE | On-chain output bounds and price-impact guard | `lib/domain/protection.ts` |

## Current work

- **IN PROGRESS** — expanding live-network verification (opt-in live tests for
  routing and execution paths).
- **IN PROGRESS** — copy and error-surface refinement for every failure mode.
- **IN PROGRESS** — mobile layout hardening across the composer, review and token
  search.
- **DONE (29C)** — product experience and presentation: one coherent story across
  the homepage, product, developer and merchant pages; a plain-language hero; a
  single lifecycle explanation; a "Why Monad" section; and a WCAG 2.2 AA contrast
  floor (`text-white/50`) across every public surface. Pinned by
  `tests/siteContent.test.tsx`.

## Next priorities

- **NEEDS VALIDATION** — additional real-device wallet compatibility testing
  (physical Android / iOS Trust Wallet and other injected wallets).
- **NEEDS VALIDATION** — end-to-end checkout validation with a real customer and a
  real merchant order.
- **PLANNED** — transparent service fee (collection plus on-screen disclosure
  before authorization). Not operational today.
- **PLANNED** — richer route comparison where additional quote sources become
  available.
- **DONE (29C)** — accessibility (WCAG 2.2 AA) pass over the public marketing and
  documentation surfaces: a `text-white/50` contrast floor (≥5.3:1 on the app
  background), verified keyboard focus visibility, and no horizontal overflow from
  360 px up. Remaining work is per-component review inside the composer/checkout.
- **PLANNED** — production observability and operational readiness beyond the
  existing diagnostics and ops endpoints.

## Longer-term vision

Intent Pay aims to be a credible, honest payment layer for Monad: a single intent
that resolves the asset, the route and the transaction, with settlement proven
on-chain and the user's keys never leaving their wallet. Growth is measured in
verified settlements and validated integrations, not in advertised features.

## Dependencies and outstanding acceptance tests

- **Physical-device wallet testing** — the wallet's native broadcast path is
  closed-source and cannot be exercised from a browser harness; a real device is
  required. See [`../AGENTS.md`](../AGENTS.md) for the invariants a device test
  should confirm.
- **Third-party developer integration** — a real external integrator has not yet
  built against the v1 API.
- **Merchant onboarding** — a real merchant has not yet completed a live order
  through the console.
