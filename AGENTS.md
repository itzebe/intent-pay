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
  sponsorship that isn't configured. The integration strip and review screen
  label the *sub-capabilities* honestly: node, ERC-4337 Bundler and Gas Manager
  are probed separately (`lib/server/diagnostics.ts`), a policy past its window
  (`ALCHEMY_GAS_POLICY_START_UNIX`/`_END_UNIX`) reads as "expired" rather than
  active, and `ALCHEMY_PAYMASTER_TOKENS` (a comma list of addresses) is the only
  thing that lets the app name a *specific* gas-abstracted pay asset. A bare
  policy id is not proof of sponsorship: `walletAbstraction.available` in
  `/api/capabilities` requires node + Bundler reachability *and* a usable policy.
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

## Paymaster honesty (ERC-20 provider *is* a paymaster)

An ERC-20 gas provider (Pimlico) is a paymaster in its own right — a wallet
with 0 MON pays the fee in a token. `resolveAbstraction`
(`lib/domain/abstraction.ts`) takes `erc20ProviderConfigured` /
`erc20ProviderAvailable` / `erc20ProviderReason`; when the provider is
configured the app must **never** say "no paymaster is configured". The
`/api/capabilities` `walletAbstraction.available` is true when *either* the
Alchemy node+Bundler+usable-policy path *or* a reachable ERC-20 provider
exists, and its `reason` names the ERC-20 provider explicitly when that is the
one configured but down. `usePayment.tsx` feeds the `gasPayment.*` capability
fields into `resolveAbstraction`.

The provider configuration can also be **unknown**: `/api/capabilities` may not
have answered yet (first paint) or may have failed. `usePayment.tsx` passes
`providersKnown: false` in that case (`capabilities === null` or the degraded
`unavailable` fallback from `useCapabilities`), and `resolveAbstraction` then
says "Checking whether gas can be paid without MON…" instead of the false "no
paymaster is configured". `IntegrationStack` renders nothing when capabilities
are degraded, so it can't show a configured provider as "Off / add a key".
Never assert absence of a paymaster from missing data.

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
  refuses every option (`gasCovered`); a configured paymaster that really
  sponsors gas lifts it.
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

## ERC-20 gas payment (EIP-7702 + paymaster)

A wallet holding USDC/USDT but **0 MON** can pay the network fee in a token it
already holds, through an EIP-7702 smart account that keeps the **same EOA
address** (no migration, no new wallet).

- **Provider is authoritative.** `lib/server/paymaster/*` (Pimlico today) is the
  *only* thing that declares an ERC-20 usable for gas. The supported-token list
  is discovered live via `pimlico_getSupportedTokens`; nothing hardcodes it.
  A discovery failure is `{ ok: false }` — never confused with an empty list
  (`normalizeSupportedTokens`). Tokens are matched by **chainId + address**,
  never by symbol.
- **The key never reaches the browser.** `lib/server/paymaster/pimlico.ts` holds
  it; the browser talks to the same-origin proxied `app/api/aa/rpc` (bundler,
  allowlisted methods) and `app/api/aa/paymaster` (ERC-20 paymaster data).
  `lib/aa/endpoint.ts` returns `/api/aa/rpc` in the browser, Pimlico directly on
  the server.
- **Selection is deterministic** (`lib/aa/gasToken.ts`, pure): supported ∩ held ∩
  sufficient balance ∩ quotable, ranked by USD cost with conversion-free and
  stablecoin tie-breaks. The same rules run server-side
  (`lib/server/paymaster/selector.ts`) and in tests.
- **Capability is not a boolean** (`lib/aa/capability.ts`): `ERC20_PAYMASTER` /
  `NATIVE` / `UNAVAILABLE` plus a specific `code`
  (`provider_unavailable|provider_error|wallet_incompatible|token_unsupported|`
  `insufficient_balance|quote_unavailable|native_required`). The UI shows "gas in
  X" only when a token was really selected from live data.
- **Execution is a genuinely different path** (`lib/aa/execution.ts`): the plan's
  steps run as one atomic UserOperation through a viem `toSimple7702SmartAccount`
  account (EntryPoint v0.8, `SIMPLE_7702_IMPLEMENTATION`), with the paymaster
  settling gas in the chosen token during postOp. An EOA tx cannot carry a
  paymaster, so this is not a relabelling.
- **Bounded spend** (`lib/aa/safety.ts`): the fee is bounded by the quoted cost
  (+20% buffer), by half the balance, and never `uint256.max`.
- **Ownership of the protection layer is unchanged.** The AA path reuses the
  same plan (`amountOutMinimum`/`amountInMaximum`), so an ERC-20-gas payment is
  covered by exactly the same slippage/price-impact/freshness guards; delivery is
  verified from the UserOperation receipt logs via `verifyDeliveryFromLogs`
  (native delivery cannot be proven from logs alone — reported unverified).
- The signing guard treats the gas asset as execution-relevant: changing the gas
  token bumps the intent version (`canonicalIntent`), and `prepareSigning`'s
  `readGasPayment` re-verifies the gas-token balance still covers the fee before
  a signature (`insufficient_gas_token`).
- `PIMLICO_API_KEY` / `PIMLICO_CHAIN_ID` in `.env.example`. Unconfigured ⇒ honest
  fallback to MON gas; `/api/capabilities.gasPayment` and
  `IntegrationStack` report configured/unreachable/tokens separately.
- **UserOperation allow-list (`lib/aa/userOp.ts`).** viem hands the paymaster
  capability a parameter bag mixing the UserOperation with transport-only keys
  (`chainId`, `entryPointAddress`, `context`). Pimlico validates strictly and
  rejects unknown keys ("Unrecognized keys … at params[0].userOp"), which fails
  the whole ERC-20 path. Both the client (`serializeUserOperation`) and the
  `/api/aa/paymaster` proxy run `filterUserOperation` so only real fields are
  forwarded.
- **Live facts (Monad mainnet 143, verified via the Pimlico prototype RPC).**
  Paymaster `0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402`; supported gas tokens
  are **USDC** (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`) and **WMON**
  (`0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`) only — **USDT is not
  supported**. `pimlico_getTokenQuotes` returns `exchangeRate`/`postOpGas`, so
  the cost formula is real, not fabricated. `tests/aaLiveVerify.test.ts`
  (gated on `AA_LIVE_TESTS=1` or `MONAD_LIVE_TESTS=1`) asserts this read-only.
- **Bounded ERC-20 gas approval (`lib/aa/gasApproval.ts`).** Pimlico's ERC-20
  paymaster recovers the fee with `transferFrom` in postOp, so the
  UserOperation must `approve(paymaster, ≥ maxCostInToken)` *before* the payment
  calls. `executePlanViaAa` fetches the live quote (`GET /api/aa/paymaster`),
  prepares the op, and prepends an `approve` bounded by
  `boundGasSpend` (≤ half the balance, ≤ a configured ceiling, never
  `type(uint256).max`). The bound uses the exact prepared gas fields, so the
  allowance is the **minimum** the live quote requires — never unlimited. The
  approval only ever touches the *gas* token; the payment source asset is a
  separate concern and is never approved.
- **postOp reverts, it does not silently underpay.** If the allowance is below
  the fee, `postOp` reverts and the whole UserOperation is not accepted
  (`AA50 PostOp Reverted` / `AA33`) — a fail-closed outcome. Verified against the
  live paymaster simulation (`tests/aaLiveVerify.test.ts`).
- **`pimlico_getTokenQuotes` `balanceSlot` is unreliable for USDC on Monad.**
  The real `balanceOf` slot for `0x7547…b603` is **9** (confirmed against live
  holders via `eth_getStorageAt`), but the provider reports `10`. Slots are only
  ever used for local simulation overrides, never for execution, so this is a
  diagnostics caveat rather than an execution risk — do not rely on the reported
  slot for anything that touches funds.

## Testing the flow


`/api/quote` accepts a JSON body and is the fastest way to exercise routing
without a wallet:

```bash
curl -s -X POST http://localhost:3000/api/quote -H 'Content-Type: application/json' \
  -d '{"recipient":"0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4","receiveToken":"USDC","receiveAmount":"5","amountMode":"recipient_receives","payToken":"USDT","mode":"live","network":"mainnet"}'
```
