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
- Natural-language intent: `lib/nlp/*` (schema, parser, engine, question, handoff, llm)
- Wallet/balances: `lib/hooks/useWallet.ts`, `app/api/balances/route.ts`
- Quote/routing: `lib/providers/*`, `lib/server/quote.ts`
- Construction: `lib/execution/plan.ts`, `lib/execution/abis.ts`
- Execution: `lib/execution/execute.ts`
- Verification: `lib/execution/verify.ts`

The routing provider is behind `lib/providers/index.ts` (`getRoutingProvider`).
Demo and live providers implement the same interface; the UI must never branch
on which provider is active beyond the demo/live label.

## Natural-language Intent Engine

`lib/nlp/*` + `app/api/nlp/route.ts` + `components/composer/IntentEngine.tsx`
turn a sentence ("Send $10 worth of MON to 0x…") into the existing payment
intent. It is an **additional interface layer**, not a second payment system:

- **Parser (`parser.ts`) is the authority.** Rule-based, offline, deterministic.
  It must keep working with no LLM configured. Three amount forms are distinct:
  `$10` → USD_VALUE/no asset, `10 MON` → TOKEN_AMOUNT/asset MON,
  `$10 worth of MON` → USD_VALUE/asset MON.
- **State machine (`schema.ts`) is derived only from the structured draft** —
  never from LLM memory. Missing field order: amount → asset → recipient.
  `NEEDS_*` states ask one question at a time (`question.ts`).
- **The LLM is optional and can only fill gaps.** `sanitizePatch` drops
  addresses, prices, routes, calldata and unknown keys; the deterministic parse
  always wins. Provider is configured via `INTENT_LLM_*` / `OPENAI_API_KEY` /
  `OPENROUTER_API_KEY`; absent/unreachable → deterministic flow only.
- **No new financial machinery.** A completed draft is handed to the existing
  composer via `prefillFromIntent` and runs the same quote → route → review →
  approval pipeline. A token-amount intent is converted to USD using the live
  price (`handoff.ts`); if there is no live price we refuse rather than fake it.
- **Never guess an address from a name.** A name is recorded as a name; the
  address is only ever an explicit, validated `0x…` value.
- **The requested output asset is authoritative** — the engine never silently
  substitutes the asset the sender happens to hold; obtaining it is the existing
  router/optimizer's job.
- **One canonical intent, no second store.** `lib/domain/canonicalIntent.ts`
  is the *only* payment state. The chat (`IntentEngine.tsx`), the composer, the
  quote, the plan and the signing guard all read it. A completed parse is
  applied through `applyNlIntent` → `nlDraftToIntentPatch` (`lib/nlp/apply.ts`);
  the continuation draft is derived back out with `draftFromIntent`, so the two
  views cannot drift (the "top says MON / missing, composer says USDC / $5" bug).
  `DEFAULT_INTENT` is deliberately empty — never re-introduce a default asset or
  amount; a hardcoded default is exactly how a stale payment appears.
- **The guard refuses a payment the UI is not showing.** `prepareSigning` takes
  `displayedKey` (from `displayKey(intent)`) and returns `composer_mismatch`
  unless it equals the canonical intent's fingerprint. This is the backstop if a
  UI desync ever reappears.
- The engine must never break the manual flow: any failure returns a non-fatal
  error and the form composer keeps working.


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
  (`lib/server/discovery.ts`); Zerion never decides execution. Use
  `fetchZerionResult()` when you must tell a provider **failure** from an empty
  wallet: it returns `status: "ok" | "disabled" | "error"`. `fetchZerionAssets()`
  is the back-compat list-only wrapper (a failure still yields `[]`). A
  configured-but-failing Zerion means the wallet's holdings are *unknown*, not
  empty — `/api/balances` exposes `sources.zerionStatus` / `zerionError`.
- **Market prices** — `lib/server/pricing/*`. Alchemy Prices (when keyed) →
  GeckoTerminal → DexScreener → on-chain Uniswap quote. Every price carries a
  `source` label surfaced in the UI. Never fabricate a rate. Prices also carry
  a freshness `status`: `LIVE` (within TTL) / `STALE` (last-known-good served
  after a refresh failure) / `UNAVAILABLE` (no numeric price — never shown as
  `$0.00`). See `lib/server/pricing/resolver.ts`, `priceStatus()`.
- **Pay-asset optimizer** — `lib/server/optimizer.ts` + `/api/optimize` rank the
  wallet's assets for the current intent; the composer uses it to recommend the
  best pay asset (replacing the old naive pick). `lib/hooks/useOptimizer.ts`.
- `/api/capabilities` reports what is configured; `components/landing/IntegrationStack.tsx`
  renders it as an honest active/off strip.
- **Test isolation**: `lib/config/tokens.ts` uses a module-level registry and
  `lib/server/http.ts` a shared `TtlCache`. Tests that touch tokens or cached
  providers must use unique addresses/keys per test or they leak state between
  cases (see `tests/pricing.test.ts`, `tests/zerion.test.ts`).
- **Live routing tests** (`tests/liveRouting.test.ts`, gated on
  `MONAD_LIVE_TESTS=1`) call `ensureCatalog("mainnet")` in `beforeAll` to
  mirror production. Without it the bounded route graph cannot discover
  intermediates that only exist in the live list (e.g. `cbBTC -> EURW -> USDC`)
  and a real route looks unavailable.


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
- **Exact-input goal ranking is descending.** The forward (exact-in) search
  ranks goals by `cost`, which for exact-input is the *output* amount, so the
  best goal is the one that delivers the **most**. Sorting ascending (as the
  exact-output branch does, where `cost` is an input) silently picks the worst
  pool — e.g. the `fee=100` USDC→MON tier instead of `fee=3000`, a >10x
  shortfall. Do not "unify" the two sorts.
- **The quote `rate` is a human rate** (receive per 1 pay), computed from
  `formatUnits` decimal-adjusted amounts — never from raw base units. A 6-dp pay
  token against an 18-dp receive token otherwise reports a rate inflated by
  10^12. Regression covered in `tests/liveRouting.test.ts`.

## Quote freshness (execution guard)

`lib/domain/freshness.ts` (client-safe) owns the single definition of a
stale quote: `QUOTE_MAX_AGE_MS` (20s hard limit) and `QUOTE_REFRESH_AFTER_MS`
(15s proactive refresh). The composer recomputes `quoteStale` each render,
auto-refreshes before expiry, disables Review/Confirm while stale, and
`onConfirm` re-checks it so a price the user saw is never the price they
sign. `lib/server/quote.ts` re-exports `isQuoteStale` for server callers.

## Execution protection (MEV / sandwich)

The product goal — an attacker cannot make the recipient receive drastically
less while the app still reports success — is enforced by the **transaction**,
not the UI.

- **On-chain output bound.** Every swap step carries a real `amountOutMinimum`
  (exact-in) or `amountInMaximum` (exact-out), derived from a clamped slippage
  tolerance (`lib/domain/protection.ts`, default 50 bps, hard ceiling 500 bps).
  `encodeStep` (`lib/execution/execute.ts`) puts it in the router calldata;
  `planHasOutputBound` (`lib/execution/signGuard.ts`) refuses to sign a swap
  with no bound. The UI's "Minimum received" is never the protection.
- **No on-chain deadline (verified).** SwapRouter02 has **no** `deadline`
  parameter — unlike the original V3 SwapRouter. The deployed Monad router
  `0xfE31F71C1b106EAc32F1A19239c9a9A72ddfb900` exposes only the deadline-less
  selectors (`exactInputSingle 0x04e45aaf`), so adding a `deadline` argument
  changes the selector and the call reverts. **Do not "add a deadline".** The
  absence is reported honestly (`ExecutionProtection.onchainDeadlineSupported =
  false`); quote freshness is enforced off-chain by `prepareSigning` refusing a
  stale quote and rebuilding the calldata. See `lib/execution/abis.ts`.
- **Price-impact guard.** `assessPriceImpact` blocks a route above
  `NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS` (default 3%) before signing. Slippage is
  never widened to rescue a bad route; an unmeasurable impact does not block
  (we never invent a number).
- **Capability states, never a boolean.** `resolveExecutionProtection` returns
  explicit states: `MEV_PROTECTION_ACTIVE` / `MEV_PROTECTION_UNAVAILABLE`,
  `SLIPPAGE_PROTECTION_ACTIVE`, `PRICE_IMPACT_PROTECTION_ACTIVE` /
  `PRICE_IMPACT_PROTECTION_UNAVAILABLE`. The review sheet shows "MEV
  Protection: Active" only when a private submission path really exists.
- **No usable private path.** `resolveMevProtection` always returns
  `MEV_PROTECTION_UNAVAILABLE`. Monad has no global mempool (RPCs forward to the
  next 3 leaders); its encrypted mempool (BTX) is not live; Alchemy's built-in
  MEV protection covers Ethereum/Arbitrum/BSC/Base/Solana, **not Monad**. A
  third-party private endpoint *does* exist on Monad mainnet (bloXroute "Monad
  Fast RPC", `monad.rpc.blxrbdn.com`), but it is only a private RPC you broadcast
  *from* — and this app never holds the key, it submits through the user's
  injected wallet (`walletClient.writeContract`), which chooses its own RPC. A
  dapp cannot force private routing onto an injected wallet, so pointing the app
  RPC at it would be a cosmetic badge. **Do not fake an "Active" badge.**

## Signing safety invariant

`prepareSigning` (`lib/execution/signGuard.ts`) is the only path to a signature.
Immediately before signing it fetches fresh balances + a fresh quote, re-reads
the canonical intent (version + key) and the wallet account, re-checks freshness,
price impact, balance/gas coverage, rebuilds the calldata from the fresh quote,
asserts the bound + deadline, and re-reads the intent a final time. Any change
aborts with a specific reason; calldata is never reused from an earlier build.

## Delivery verification

`verifyDelivery` (`lib/execution/verify.ts`) proves the recipient's actual
on-chain transfer from the confirmed receipt, against the minimum the
transaction enforced (the plan's `slippageBps`). A reverted tx is failed;
an unprovable delivery is shown as unverified — never as success.

## Partial-balance split ("send what you hold + convert the rest")

A token-quantity intent (`receiveTokenAmount`, set only from a genuine
"send 100 NEWCOIN" phrase — never from a USD intent's derived token amount) may
exceed what the wallet holds. When another funded asset can cover the shortfall
the payment runs as **two protected legs**:

- `lib/domain/partialBalance.ts` — pure `splitPayment()` (scaled-integer, never
  float) decides held vs shortfall; `pickShortfallSource()` picks the most
  valuable non-target holding.
- `lib/server/partial.ts` — `buildPartialLegs()` quotes both legs live (direct
  same-asset transfer of the held part + a real swap for the shortfall). No
  route for the shortfall → a failure, never a fabricated split.
- `lib/execution/plan.ts` — `buildPartialPlan()` assembles the step list;
  `partialPlanMinimum()` is the recipient guarantee across both legs. Each swap
  leg keeps its own real `amountOutMinimum`.
- The signing guard rebuilds the split from fresh balances via `fetchPlan` +
  `covers` (`prepareSigning`), so a sandwich can only make a leg revert.
- Native MON is never used to cover a shortfall (reserved for gas), and a split
  is only taken when `flow.partial.covered` is true — otherwise the normal or
  insufficient path runs unchanged.

## Testing the flow


`/api/quote` accepts a JSON body and is the fastest way to exercise routing
without a wallet:

```bash
curl -s -X POST http://localhost:3000/api/quote -H 'Content-Type: application/json' \
  -d '{"recipient":"0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4","receiveToken":"USDC","receiveAmount":"5","amountMode":"recipient_receives","payToken":"USDT","mode":"live","network":"mainnet"}'
```
