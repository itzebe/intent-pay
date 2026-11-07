# Intent Pay — technical architecture

The layered system, as it exists in the repository. Each layer has one job and a
single owner module; the UI never branches on which routing provider is active.

## Layers

| Layer | Responsibility | Module |
| --- | --- | --- |
| Intent | Canonical payment state | `lib/domain/canonicalIntent.ts`, `lib/domain/intent.ts` |
| Validation | Recipient, amount, asset, route | `lib/domain/validation.ts` |
| Natural language | Optional sentence -> intent (deterministic first) | `lib/nlp/*` |
| Wallet | Discovery + connection | `lib/hooks/useWallet.tsx`, `lib/wallet/*` |
| Balances | Per-wallet holdings | `app/api/balances/route.ts`, `lib/server/discovery.ts` |
| Quote / routing | Uniswap V3 exact-in / exact-out | `lib/providers/uniswapV3.ts`, `lib/server/quote.ts` |
| Construction | Step list + calldata + bounds | `lib/execution/plan.ts`, `lib/execution/abis.ts` |
| Execution | Submit one step at a time, confirm each | `lib/execution/execute.ts` |
| Verification | Prove the recipient's transfer | `lib/execution/verify.ts` |
| Developer API | Versioned HTTP surface | `app/api/v1/*` |
| Store | Persistence (referral, attempts, webhooks) | `lib/store/*` |

## Data flow

```
  User / Merchant customer
        |
        | states the payment
        v
  Intent Pay frontend  <----  Developer integration (API key -> /api/v1)
        |
        v
  canonical intent  ->  Quote + route  ->  Plan (approve / swap / unwrap / deliver)
        |
        v
  Signing guard (rebuilds from fresh data)
        |
        v
  User's wallet  --eth_sendTransaction-->  Monad Mainnet (chain id 143)
        |
        v
  Confirmed receipt  ->  verifyDelivery  ->  Merchant outcome  ->  Webhook delivery
```

## Key invariants

- **One canonical intent.** `lib/domain/canonicalIntent.ts` is the only payment
  state. A completed natural-language parse is applied through `applyNlIntent`;
  the continuation draft is derived back with `draftFromIntent`, so the chat and
  the composer cannot drift.
- **The guard refuses what the UI is not showing.** `prepareSigning` takes the
  displayed fingerprint and refuses with `composer_mismatch` unless it matches
  the canonical intent.
- **A submission is never retried.** Every viem wallet action that signs or
  submits passes `{ retryCount: 0 }`; the checkout and SDK use the bare EIP-1193
  provider.
- **The gas checked is the whole plan.** `planGasUnits` sums a per-step estimate;
  readiness and the signing guard compare the wallet's MON against the total.
- **On-chain output bound.** Every swap step carries a real
  `amountOutMinimum` / `amountInMaximum`; `planHasOutputBound` refuses to sign a
  swap with no bound. The UI's "Minimum received" is not the protection.
- **No on-chain deadline.** Monad's deployed SwapRouter02 exposes only the
  deadline-less selectors; the absence is reported honestly and freshness is
  enforced off-chain by refusing a stale quote.
- **Unknown outcomes stay unknown.** `recoverSubmission` classifies an outcome
  from real on-chain reads; a pending nonce is never proof of submission.
- **External metadata is not authoritative.** `resolveByAddress` re-reads
  `decimals()`/`symbol()` on chain before a token can be spent.

## Concurrency and shared state

There is no per-user server session. The canonical intent lives in the browser;
every server handler is a stateless function of its request body. The only
process-wide state is provider caching, keyed by user-supplied identity
(address, pool address, token) and never carrying a user identity. Expensive
shared work is de-duplicated in flight (`TtlCache`, `graphInflight`,
`priceInflight`); client races are version-guarded (`createLatestGuard`).

## Deployment

- Frontend + API: Next.js on Vercel (managed Node.js runtime).
- Store: Postgres when `DATABASE_URL` is set (durable), else SQLite or memory.
  Payment execution never depends on the store.
- No paymaster, bundler, UserOperation or EIP-7702 path exists.
