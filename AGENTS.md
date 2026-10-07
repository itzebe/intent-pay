# AGENTS.md

Repository knowledge for agents working on Intent Pay.

## What this is

An intent-based payment layer for Monad. The user states what the recipient
should receive (recipient, dollar amount, receive token); the app determines
which asset the sender spends, the amount, the route, and the execution.

It is deliberately **not** a swap UI. Copy should say "Pay", not "Swap".

## Commands

```bash
npm run dev      # dev server
npm test         # vitest (unit tests for math, validation, path, demo provider)
npm run build    # production build + typecheck
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
```

Note: `next dev` and `next build` both write to `.next/`. Running a build while
a dev server is live can break the dev server's module cache; restart the dev
server (or remove `.next`) afterwards.

## Architecture layers

- Intent: `lib/domain/intent.ts`, `lib/domain/validation.ts`
- Wallet/balances: `lib/hooks/useWallet.ts`, `app/api/balances/route.ts`
- Quote/routing: `lib/providers/*`, `lib/server/quote.ts`
- Construction: `lib/execution/plan.ts`, `lib/execution/abis.ts`
- Execution: `lib/execution/execute.ts`
- Verification: `lib/execution/verify.ts`

The routing provider is behind `lib/providers/index.ts` (`getRoutingProvider`).
Demo and live providers implement the same interface; the UI must never branch
on which provider is active beyond the demo/live label.

## Ecosystem integrations (T10)

Three external providers are wired in, all config-driven and honest about
whether they are configured. `.env.example` documents every key.

- **Uniswap** — `lib/providers/uniswapV3.ts` is the live routing engine
  (exact-output, pool discovery, all fee tiers). Do not replace it; the
  optimizer and quote layer call through `getRoutingProvider`.
- **Alchemy** — `lib/server/gasCapabilities.ts` (server) and
  `lib/execution/alchemy.ts` (client). Provides Alchemy RPC transport, and,
  when `ALCHEMY_API_KEY` + `ALCHEMY_GAS_POLICY_ID` are set, EIP-5792
  `wallet_sendCalls` batching with optional gas sponsorship / ERC-20 gas.
  `getWalletCapabilities` asks the user's own wallet what it supports; when it
  does not, execution falls back to sequential MON-gas txs. Never claim
  sponsorship that isn't configured.
- **Zerion** — `lib/server/zerion.ts`. HTTP Basic auth (key as username, empty
  password) against `https://api.zerion.io`; supplies wallet asset discovery and
  USD valuation. Balances that get spent are still confirmed on-chain
  (`lib/server/discovery.ts`); Zerion never decides execution. Returns `[]` on
  any failure — never treat that as "empty wallet".
- **Market prices** — `lib/server/pricing/*`. Alchemy Prices (when keyed) →
  GeckoTerminal → DexScreener → on-chain Uniswap quote. Every price carries a
  `source` label surfaced in the UI. Never fabricate a rate.
- **Pay-asset optimizer** — `lib/server/optimizer.ts` + `/api/optimize` rank the
  wallet's assets for the current intent; the composer uses it to recommend the
  best pay asset (replacing the old naive pick). `lib/hooks/useOptimizer.ts`.
- `/api/capabilities` reports what is configured; `components/landing/IntegrationStack.tsx`
  renders it as an honest active/off strip.
- **Test isolation**: `lib/config/tokens.ts` uses a module-level registry and
  `lib/server/http.ts` a shared `TtlCache`. Tests that touch tokens or cached
  providers must use unique addresses/keys per test or they leak state between
  cases (see `tests/pricing.test.ts`, `tests/zerion.test.ts`).


## Conventions

- Everything token/chain related is config-driven: `lib/config/tokens.ts`,
  `lib/config/chains.ts`, `lib/providers/constants.ts`. Never hardcode a token
  symbol in a component or route.
- Amounts shown to the user are USD-primary (`usdTokenLabel`); raw token amounts
  are secondary detail.
- Demo mode must be labelled wherever it appears, and must never produce a
  transaction hash or claim a real transaction.
- Live mode must fail honestly (`route_unavailable`, `unsupported_token`) rather
  than fabricating a quote.
- Exact-payment protection only fires on over-delivery. A shortfall is expected
  in "I spend" mode.

## Token states (honesty model)

`lib/domain/tokenState.ts` derives one canonical state per token:
`UNKNOWN → DISCOVERED → PRICE_AVAILABLE/PRICE_UNAVAILABLE →
ROUTE_AVAILABLE/ROUTE_UNAVAILABLE → PAYABLE`. `PAYABLE` requires existence,
metadata, a trustworthy price *and* a real route. `/api/tokens` exposes
`state`, `stateFlags` and `payable`; never treat "the token resolves" as
"the token is payable".

## Dynamic asset discovery

- A wallet balance may arrive keyed by **symbol or contract address**. The
  optimizer resolves address → runtime registry → chain, so a token never
  shipped in source is still optimizable (`/api/optimize`, `useOptimizer`).
- External metadata (Zerion `source: "wallet"`) is **not** authoritative.
  `resolveByAddress` re-reads `decimals()`/`symbol()` on chain before the token
  can be spent, so a wrong reported scale can never mis-scale a payment.
- `isRoutable(token)` probes with the token as an **endpoint**; it must not rely
  on a cached graph, or a freshly discovered token answers a false "no route".
- `basisTokens()` includes the **native MON** (pooled as WMON). It is the usual
  intermediate for multi-hop routes; omitting it makes a cold graph unable to
  find e.g. `USDC -> MON -> <new token>` even though those pools exist.

## Routing gotchas (Monad / Uniswap V3)

- **QuoterV2 returns its result by reverting.** `client.multicall()` discards
  revert data, so it reports every quote as a failure. `quoteMany` calls
  Multicall3 `aggregate3` directly (`MULTICALL3_ADDRESS`) and decodes each raw
  return; the single-call fallback must read `err.data` / `err.cause.data`.
- **Every fee tier must be quoted.** A token can have a `fee=100` pool that
  reverts while the `fee=3000` pool holds the real liquidity. Collapsing a
  neighbour to one arbitrary fee tier silently kills the route.
- **Graph reuse must be keyed on probed basis tokens**, not merely "token is a
  node". `coversEndpoints` checks `basisKeys`; otherwise a later quote reuses a
  graph where the new token's pair was never probed.
- SOL has no liquidity on Monad today — `USDT -> SOL` failing live with
  `route_unavailable` is correct, not a bug. Demo mode quotes it as sample data.
- The native MON endpoint is `0x0` and is wrapped to WMON (`NATIVE_POOL_KEY`)
  for pool lookup; `priceUsd` handles the native basis token.

## Testing the flow

`/api/quote` accepts a JSON body and is the fastest way to exercise routing
without a wallet:

```bash
curl -s -X POST http://localhost:3000/api/quote -H 'Content-Type: application/json' \
  -d '{"recipient":"0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4","receiveToken":"USDC","receiveAmount":"5","amountMode":"recipient_receives","payToken":"USDT","mode":"live","network":"mainnet"}'
```
