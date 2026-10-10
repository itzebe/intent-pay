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
- **Alchemy** — RPC transport only (`lib/server/diagnostics.ts` probes the
  node; `lib/config/chains.ts` builds the browser RPC URL). Alchemy is **not**
  used to sponsor or abstract gas: the standard EOA path always pays the network
  fee in MON. The integration strip reports node reachability, and the
  configured market-price source, honestly. There is no paymaster, bundler,
  UserOperation or EIP-7702 code in the repository.
- **Zerion** — `lib/server/zerion.ts`. HTTP Basic auth (key as username, empty
  password) against `https://api.zerion.io`; supplies wallet asset discovery and
  USD valuation. Balances that get spent are still confirmed on-chain
  (`lib/server/discovery.ts`); Zerion never decides execution. Use
  `fetchZerionResult()` when you must tell a provider **failure** from an empty
  wallet: it returns `status: "ok" | "disabled" | "error"`. `fetchZerionAssets()`
  is the back-compat list-only wrapper (a failure still yields `[]`).
  `fetchZerionPortfolio()` returns the wallet's `total` USD value and per-chain
  distribution for enrichment. A configured-but-failing Zerion means the
  wallet's holdings are *unknown*, not empty — `/api/balances` exposes
  `sources.zerionStatus` / `zerionError`. Zerion being unavailable must never
  break payment execution (the on-chain balance is authoritative).
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
stale quote: `QUOTE_MAX_AGE_MS` (20s hard limit), `QUOTE_REFRESH_AFTER_MS`
(15s proactive refresh) and `QUOTE_RETRY_AFTER_MS` (4s backoff for a failed
refresh). The composer recomputes `quoteStale` each render,
auto-refreshes before expiry, disables Review/Confirm while stale, and
`onConfirm` re-checks it so a price the user saw is never the price they
sign. `lib/server/quote.ts` re-exports `isQuoteStale` for server callers.

### Refresh resilience (a transient failure must not destroy the payment)

`lib/domain/quoteState.ts` (pure) is the one rule for what a failed quote
*refresh* does to the payment slot. A **transient** failure (`provider_error`,
`quote_unavailable` — the provider couldn't be reached or timed out) while the
last-known-good quote for the *current intent version* is still held **keeps
that quote and its timestamp** (so staleness keeps ageing honestly) and records
`quoteRefreshFailedAt`; a backoff effect in `usePayment.tsx` re-quotes after
`QUOTE_RETRY_AFTER_MS`. A **definitive** failure (`route_unavailable`,
`unsupported_token`, …) is a real state change and clears the quote so the
honest error shows. A failure with no usable quote for the current version also
clears. `usePayment.tsx` routes the fetch success and both failure paths through
`applyQuoteSuccess`/`applyQuoteFailure`; only `applyQuoteFailure` may keep or
clear the slot, never a raw spread.

## Review stays inside the flow

A `prepareSigning` refusal (a moved price, a drained balance, an account
switch) is **recoverable**, not a reason to eject the user: `PaymentComposer`
keeps `stage === "review"`, shows the guard's specific message, refreshes the
quote, and offers a Retry action (`ReviewSheet.onRetry` → `onConfirm`).

A version bump the **engine itself** performs while the user is on Review (the
optimizer re-picking a source, an account/revalidation event) must **never**
eject them back to the composer — that was the reported "Confirm → loading →
previous screen" loop. The review-invalidation effect therefore no longer calls
`setStage("compose")`: it keeps Review mounted and, when the intent genuinely
moved on with no fresh quote yet, shows a soft `reviewNotice` and re-anchors
`reviewVersionRef`. Rules, in order: (1) a quote that already matches the
current intent is adopted silently (and clears the notice); (2) a refresh in
flight does not eject; (3) while `holdReviewRef` is set (a signing attempt owns
the screen) nothing ejects — `prepareSigning` refuses the signature instead;
(4) otherwise keep the user on Review. Review also renders from
`reviewQuote = flow.quote ?? lastQuoteRef.current`, so a momentarily-null quote
mid-refresh never blanks the subtree; `canConfirm` (fresh quote for the current
intent + not stale + readiness) gates the Confirm button, and `onRefresh` gives
an explicit retry on a stale quote. Do not send a recoverable preparation error,
or an engine-driven version bump, back to a blank composer.

## Token names resolve internally (never ask for an address)

The user must never enter a contract address. `resolveToken`
(`lib/server/discovery.ts`) resolves a token by ticker **or** display name
("USDC" or "USD Coin" → `0x754704…b603`), symbol first so a shared name can't
shadow a ticker, and only an *unambiguous* exact name match is accepted (two
contracts sharing a name are never guessed between). Address remains the
authoritative identity; the name path only supplies it. Note the deterministic
NL parser is ticker-only, so "Send 10 USD Coin" still asks which asset — that is
acceptable because it never guesses and never asks for an address; do not
loosen the parser to treat a multi-word name as a ticker.

## Gas is always paid in MON (no abstraction)

Intent Pay executes through the user's own injected wallet (an EOA). The
network fee is **always** paid in native MON. There is no paymaster, bundler,
UserOperation, EIP-7702 authorization or ERC-20-gas path in the codebase — that
infrastructure was removed. `lib/domain/sourceSelection.ts` (`selectSource`,
`gasCovered`) and `lib/execution/signGuard.ts` therefore treat MON coverage as a
hard requirement: a wallet with no MON to cover the fee is blocked with an
explicit reason, never silently routed through a sponsorship path that does not
exist. `GasMode` is the single member `"native"`.

Do not reintroduce a "gasless" claim or a sponsorship badge. If a wallet holds
no MON, say so plainly and name the real blocker.

### The gas checked is the WHOLE plan, not one transaction

A swap payment is **several** sequential transactions (approve → swap → unwrap →
deliver), and each charges its own fee. Validating only a single transaction's
fee is what produced the reported "small MON payment fails with a generic
transaction error": the review showed a green fee, then the *second* transaction
failed with the node's `insufficient funds for gas`. The fix is plan-wide:

- `lib/execution/plan.ts` — `stepGasUnits(step)` and `planGasUnits(plan)` sum a
  per-step gas estimate across the whole plan (approve/wrap/unwrap/swap/transfer).
- `lib/server/quote.ts` — builds the plan (with placeholder addresses; the step
  list does not depend on sender/recipient identity) and prices the quote's
  `gasLimit` from `planGasUnits`, so the displayed network cost and the readiness
  gate both use the **total**. A plan-shape failure falls back to the provider's
  single-transaction estimate rather than breaking the quote.
- `computeReadiness` (`insufficient_gas`) and `prepareSigning` (`coversGas`) then
  compare the wallet's MON against the plan total. `coversGas` keeps a 20% buffer.

**There is no minimum transfer amount.** Neither the product nor Monad imposes
one; a tiny amount is valid. The two real constraints — insufficient MON for the
total fee, and no route/liquidity for a conversion — are named honestly and must
never be described as a "minimum". `MIN_EXECUTABLE_LIQUIDITY_USD`
(`lib/domain/tokenRisk.ts`) is a per-token *swap-liquidity* floor, not a payment
minimum, and `Amount is too small to send` (`validateAmount`) only fires when an
amount rounds below one base unit at the token's decimals.

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

## Source-asset selection (sender side)

The intent is stated in terms of what the **recipient** receives. The sender's
asset is decided separately and never inferred from the recipient's asset.

- **A token-quantity names the recipient, not the source.** "10 MON" sets
  `receiveToken: MON` + `receiveTokenAmount: 10`. `payToken` stays **unset** so
  the live balances decide the best asset to spend. The source is fixed only by
  the explicit "N A worth of B" form (`sourceAsset`) — a genuine user choice.
- `lib/domain/sourceSelection.ts` (`selectSource`) is the deterministic engine:
  balances + ranked optimizer options → one source with a human reason. Order:
  an explicit choice while usable (authoritative, never silently replaced) →
  the best executable + sufficient option (live cost order) → honest failure
  codes (`no_balances`, `none_executable`, `explicit_unusable`).
- Gas is a hard constraint: with native gas and no MON reserve the engine
  refuses every option (`gasCovered`). There is no sponsorship path that lifts
  it.
- `pending` is a distinct state — while the optimizer is still loading
  (balances present, no options yet) the engine says "Finding…", it never emits
  a false "none of your holdings is enough".
- `lib/hooks/usePayment.tsx` adopts the engine's auto-pick, keeps an already
  usable source until it becomes unavailable, and feeds `sourceBlocked` into
  `computeReadiness` (a hard block for auto-selection; a fixable block for an
  unusable explicit choice). `components/composer/PayAssetPicker.tsx` always
  shows the engine-selected source with its rationale.

## Crash-proofing external token data

A token may arrive from a wallet indexer, a pasted address or a remote list with
**missing** `symbol`/`tint`/`decimals`. That used to throw inside `TokenBadge`
(`shade(undefined)` → `undefined.replace`) with no error boundary, unmounting
the tree → a blank page (the USDC→MON report).

- Every external token is normalized on ingest: `normalizeTokenConfig` /
  `registerToken` (`lib/config/tokens.ts`), plus `useTokenCatalog` and the
  composer's balance ingestion. `tint` is derived deterministically from the
  address when absent; `decimals` falls back to 18; `symbol` to "Unknown".
- `components/ui/TokenBadge.tsx` validates its tint and never throws as a last
  line of defence.
- `components/ErrorBoundary.tsx` wraps the app (`app/page.tsx`, scope="app") and
  the composer (`components/AppShell.tsx`, scope="composer"), so a single bad
  subtree can never blank the whole product.

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

## Confirmation outcomes (a broadcast is not a success)

`executePlan` (`lib/execution/execute.ts`) returns `{ primaryHash, results,
confirmed }`. `confirmed` is true only when **every** step reached a successful
receipt. A step whose receipt was not observed within the confirmation window
(90s, 2 confirmations) is reported with `unconfirmed: true` and its hash kept,
`confirmed` becomes false, and the remaining steps are **not** run (they were
built to follow a confirmed predecessor). The composer then shows the
`UnresolvedPanel` ("Transaction status unknown") — never the success screen —
with the hash(es), a read-only "Check transaction status" action
(`checkUnresolvedStatus` re-reads the real receipt; a confirmed one proceeds to
`verifyDelivery`, a reverted one is reported, a still-absent one stays unknown),
and Retry / Back-to-edit. Nothing is ever resubmitted automatically.
`SuccessScreen` only reads "delivered" when `delivery.verified` is true; an
unverified delivery reads "sent / broadcast, delivery not yet proven".

## Actionable transaction errors

`lib/domain/transactionError.ts` (`classifyTransactionError`, pure) maps any
thrown value — a viem `ExecutionError`, an EIP-1193 code, or a raw provider/RPC
string — to a fixed, user-safe `{ kind, message, mayHaveSubmitted, action? }`.
The raw provider string is never shown. `mayHaveSubmitted` (submitted, RPC
failure) means the tx may already be on-chain and must not be retried blindly;
it is fed into the payment diagnostic. Add new provider phrasings here, not in
the component.

## Error boundaries

`app/error.tsx` (route segment) and `app/global-error.tsx` (root layout) join the
`ErrorBoundary` in `components/ErrorBoundary.tsx` (scope="app" and
scope="composer") so no thrown render error can blank a page.

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
