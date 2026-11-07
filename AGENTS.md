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
- Wallet/balances: `lib/hooks/useWallet.tsx`, `lib/wallet/*`, `app/api/balances/route.ts`
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


## Wallet connectivity (EIP-6963 + WalletConnect)

One shared connection, several wallets. `lib/hooks/useWallet.tsx` exports
`WalletProvider` (mounted once in `components/AppShell.tsx`) and `useWallet()`;
the hook's return shape is a superset of the old standalone hook, so every
existing consumer keeps working. **Do not create a second `useWallet` instance**
— one provider means one set of `accountsChanged`/`chainChanged` listeners and
one account/chain/client the composer, header and referral panel all agree on.

- **Discovery** is `lib/wallet/eip6963.ts`. It dispatches `eip6963:requestProvider`
  and collects `eip6963:announceProvider` details, then folds in the legacy
  `window.ethereum` (and its `providers[]`), de-duplicated by provider identity.
  It is React-free so it can be unit-tested against a fake `window`. Never read
  `window.ethereum` anywhere else — a page with MetaMask + Rabby + Coinbase would
  otherwise see only whichever won the slot.
- **Late legacy injection must survive past the fast poll.** `watchWallets` runs a
  250 ms poll for 6 s (`LEGACY_POLL_WINDOW_MS`) for a wallet that injects after
  first paint, then **drops to a 2 s slow poll (`LEGACY_SLOW_POLL_MS`) until
  `destroy`** rather than stopping. A Trust Wallet Android in-app browser was
  observed injecting its legacy-only provider ~9 s after boot; stopping at 6 s is
  exactly the reported "no browser wallet detected" on a real device. The
  `WalletPicker` also re-scans on open, so a provider that arrives while the app
  is idle is offered at the moment the user asks to connect. `destroy` clears
  both the fast timer and the slow poll.
- **WalletConnect** is `lib/wallet/walletconnect.ts`, a lazy-loaded connector
  behind `getWalletConnectProvider()`. The SDK (`@walletconnect/ethereum-provider`)
  is imported on demand, so it is code-split out of the main bundle. It is
  **config-gated on `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`** (public; free from
  https://dashboard.reown.com). With no project id `walletConnectConfigured()` is
  false, the option renders disabled with the real reason, and no session is
  fabricated. Session restoration re-inits the provider and checks `eth_accounts`;
  an empty account list means the session expired and we stay disconnected.
- **Lifecycle rules** live in `lib/wallet/connection.ts` (pure): `chainIdFromHex`,
  `isMonadChainId`, `firstAccount`, `statusForAccounts`, `pickRestorableWallet`,
  `connectionErrorMessage`. An empty account list is a disconnect, never a half
  state; a raw provider error string is never echoed to the user.
- **A page-world provider's chain read is best-effort, and its RPC must be in
  `connect-src`.** An injected EIP-1193 wallet (Trust Wallet's Android in-app
  browser is the concrete case) answers `eth_chainId`/`eth_call` by *proxying to
  its own node from our page context*, so our `connect-src` governs that fetch.
  With the wallet's origin omitted the browser refuses the request before it
  leaves the device: the wallet is discovered and selectable, but `connect()`
  throws a bare `TypeError: Failed to fetch` (no EIP-1193 code) and the user saw
  "Couldn't connect to the wallet" — the reported "Connect Wallet depends on
  WalletConnect" regression. Two rules follow:
  - `next.config.mjs` `connect-src` includes `injectedWalletRpcOrigins`
    (`https://monad.twnodes.com` — Trust Wallet's Node-as-a-Service Monad RPC).
    It is a `connect-src` relaxation only; no `script-src` origin is added. Never
    remove it: it is what lets a direct injected connection work **without**
    WalletConnect being configured.
  - `connect()` reads the chain with `safeChainId()` and never lets a failed
    chain read fail the connection: an unreadable chain is reported as *unknown*
    (`undefined`), never silently coerced to Monad. A wallet that returns no
    account is an honest "didn't share an account" message, not a phantom
    connection — and a failed injected attempt never falls back to WalletConnect.
- **`monad.twnodes.com` is Trust Wallet's own RPC, not ours.** The endpoint a
  user sees in "Failed to connect to `http://monad.twnodes.com/` …:443" comes
  from the *wallet's* built-in Monad network entry (`x-tw-naas-request-id`
  header = Trust Wallet NaaS, Alchemy-backed); it appears in no repo file and no
  Vercel env var. The `http://` + `:443` shape is the wallet's own upgrade path:
  `http://monad.twnodes.com/` answers `301 → https://monad.twnodes.com:443/`. We
  never supply it — `monadAddChainParams` hands the wallet `https://rpc.monad.xyz`
  (`tests/monadChain.test.ts` pins this). A stale custom Monad entry already
  stored in a user's wallet is the wallet's to fix; we do not silently rewrite it.
- **`isMonadChain` accepts both chain-id forms** (`0x8f` and `143`), so a
  provider's hex quantity and a WalletConnect decimal are judged the same chain.
- **UI** is `components/wallet/WalletBar.tsx`: `ConnectButton` (picker + connected
  menu) and `BalanceOverview`. The picker shows every discovered injected wallet,
  WalletConnect (when configured), and an honest "no browser wallet detected"
  note. A wallet icon that the CSP blocks falls back to a neutral glyph.
- **Gas is unchanged**: the connected provider signs locally and pays the fee in
  MON. No paymaster, bundler or AA path was reintroduced.
- **CSP** (`next.config.mjs`) lists the WalletConnect relay/verify origins and
  relaxes `frame-src` for `secure.walletconnect.org` **only when the project id
  is set**; an unconfigured deploy keeps `frame-src 'none'`. `connect-src` also
  always includes the injected-wallet RPC origins (`injectedWalletRpcOrigins` —
  Trust Wallet's `monad.twnodes.com`), because a page-world provider's chain read
  is subject to our CSP and blocking it breaks direct injected connection. `img-src`
  stays tight (`'self' data: blob:` + the GitHub token-logo host).
- `/api/capabilities.wallets` reports injected discovery as always-on and
  WalletConnect as `configured: false` unless keyed; `IntegrationStack` renders it.

Regression coverage: `tests/walletDiscovery.test.ts`, `tests/walletConnection.test.ts`,
`tests/walletConnect.test.ts`, `tests/walletIntegration.test.tsx` (jsdom, mocked
EIP-1193 provider), `tests/walletError.test.ts` (network-failure classification),
`tests/monadChain.test.ts` (EIP-3085 params + chain-id forms), plus the
WalletConnect and injected-wallet-RPC CSP cases in `tests/securityHeaders.test.ts`.

### A wallet's own flag wins over the shared `isMetaMask`

Trust Wallet sets `isMetaMask` for dapp compatibility, so `legacyProviderName` /
`legacyWalletId` (`lib/wallet/eip6963.ts`) check the most specific flag first
(`isRabby` → `isCoinbaseWallet` → `isTrust`/`isTrustWallet` → `isMetaMask`). A
legacy-only Trust provider was otherwise labelled "MetaMask", hiding the wallet
the user actually had. The id and the display name share the order so they can
never disagree.

### The wallet picker must portal to `document.body`

`position: fixed` is resolved against the nearest ancestor that establishes a
containing block, and a `backdrop-filter` (the sticky header's `backdrop-blur-xl`)
is one. A `Modal` rendered where its trigger lives — inside that header — was
therefore laid out against the ~69px header instead of the viewport: the picker's
rows landed off-screen and could not be tapped, so the user could open "Connect a
wallet" but never connect. `components/ui/Modal.tsx` renders through
`createPortal(..., document.body)` (after a `mounted` guard, for SSR), so the
overlay is always the real viewport regardless of any ancestor's
filter/transform. Do not move a `Modal` back into a filtered/transformed
ancestor. Reproduction: `scripts/mission23/modalGeometry.mjs`; regression:
`tests/modalPortal.test.tsx`.

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
- **An empty read is `provider_error`, not `route_unavailable`.** The Monad public
  RPC intermittently answers HTTP 200 with **no usable data** (an observed
  429-with-an-empty-body) instead of throwing. A batch whose every sub-call
  succeeds-but-decodes-to-null is infrastructure, not "no liquidity". `multicall`
  and `quoteMany` therefore set `this.rpcFailed = true` when a non-empty batch
  yields zero successful reads, so `routeFailure` classifies it as the
  *transient* `provider_error`. Without this the client treated the outage as a
  definitive `route_unavailable`, cleared its last-known-good quote and stopped
  retrying — a transient outage became a permanent dead end. Regression:
  `tests/rpcEmptyResponse.test.ts` (which also asserts that a genuinely cold
  graph against a *responsive* node still reports `route_unavailable`).
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

## RPC reliability (an unreachable node is never a market fact)

Every chain read goes through a **fallback transport**, never a single
endpoint. `serverRpcUrls()` / `browserRpcUrls()` (`lib/config/chains.ts`) list
the keyed provider first and **always end at the key-free public Monad RPC**
(`rpc.monad.xyz`). `getPublicClient` (`lib/server/rpc.ts`) and
`getClientPublicClient` (`lib/wallet/clients.ts`) build on viem `fallback(..., {
rank: false })`, so a 429 / timeout on the keyed endpoint degrades to the public
node instead of failing every pool read and every receipt wait. Without this, a
rate-limited Alchemy endpoint (observed: HTTP 429 with an empty body) made the
whole server read layer fail.

**An unreachable RPC is a transient `provider_error`, not `route_unavailable`.**
`isRpcUnreachable` (`lib/providers/uniswapV3.ts`) walks the viem `cause` chain:
`HttpRequestError` / `TimeoutError` / `RpcRequestError` and empty-body messages
(`fetch failed`, `Unexpected end of JSON input`) are infrastructure; a
`ContractFunctionRevertedError` — or a revert **carrying encoded data**, which is
the QuoterV2 answer — is a real on-chain answer. When a read failed for
infrastructure reasons, `routeFailure()` returns `provider_error` (and the quote
skips the "no route" alternatives). `provider_error` is transient, so the
composer keeps the last-known-good quote and retries; `route_unavailable` is
definitive and clears the slot. Reporting an outage as `route_unavailable` was
the reported "swap quote cannot be recovered" bug — a blip shown as a permanent
market fact.

A graph built while the RPC was failing is **not cached** for `GRAPH_TTL_MS`; it
is returned for that call only, so a one-second blip cannot become five minutes
of "no route".

**Recovery is not limited to a held quote.** `shouldRetryQuote`
(`lib/domain/quoteState.ts`) is the single rule for whether a failed quote slot
auto-retries: true while a quote is held, and true for a *transient* failure with
no held quote (a cold quote taken during a hiccup). A definitive failure is never
auto-retried. `usePayment.tsx` keys its backoff effect off this function.

Regression coverage: `tests/rpcResilience.test.ts` (candidate lists, fallback
transport, recovery), `tests/routeDiscovery.test.ts` (an RPC outage surfaces as
`provider_error`).

### A stalled endpoint must fail over — viem `fallback` does not

`fallback` advances to the next endpoint only when a call **throws**. A node that
accepts the TCP connection and then never replies throws nothing until its own
timeout, so a stalled *preferred* endpoint made every read pay that timeout
(`lib/server/rpc.ts` used 20 s, `lib/wallet/clients.ts` the same). On the
deployed app that was the production outage: `/api/balances`, `/api/tokens` and
`/api/quote` each blocked past the serverless limit, balances looked empty and a
payment could never be prepared. This is distinct from the 429 case above —
there the endpoint *answers*, here it never does.

`lib/rpc/receiptFailover.ts` therefore owns the failover itself, built with
viem's `createTransport` so it carries a real `type` and `retryCount: 0`:

- Every application-owned endpoint is instantiated with `retryCount: 0`. The
  transport owns failover; a viem-level retry would re-run the whole ordered
  attempt and re-hit an endpoint the breaker is cooling down, multiplying every
  attempt (`1 + retryCount`) against a stalled node. **Do not pass `retryCount`
  to `http(...)`** in the client builders: viem resolves it as
  `config.retryCount ?? transport.retryCount`, so an endpoint-level value silently
  overrides the transport's `0` and the stalled endpoint is hit twice.
- `ENDPOINT_TIMEOUT_MS` (5 s) is the *only* bound on a stalled read. A healthy
  Monad node answers a read in well under a second.
- A failed endpoint is skipped for `ENDPOINT_COOLDOWN_MS` (15 s) so only the
  first read in a request pays the stall; the next endpoint is used directly.
  If every endpoint is cooling down they are still tried, never dropped.
- A receipt read still fails over on a `null` (the original behaviour): only a
  non-null answer is authoritative.

Failover stays **sequential on purpose**. viem's `http` transport coalesces
concurrent requests to one endpoint into a single batched POST, so a 125-call
`multicall` is one request per endpoint; racing the endpoints (a hedge) would
instead send 125 concurrent POSTs to the fallback and overrun it.

Regression coverage: `tests/receiptFailover.test.ts` (a stalled endpoint is
skipped after one timeout and a later endpoint answers; a receipt `null` fails
over), plus the candidate-list cases in `tests/rpcResilience.test.ts`. The
end-to-end reproduction is `scripts/mission23/rpcStallProbe.mjs`.

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
honest error shows. A **transient** failure with no held quote also schedules a
retry — see `shouldRetryQuote`, the single rule for this; a cold quote taken
during an RPC blip used to be a dead end. `usePayment.tsx` routes the fetch
success and both failure paths through `applyQuoteSuccess`/`applyQuoteFailure`;
only `applyQuoteFailure` may keep or clear the slot, never a raw spread.

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

## Never lose the cause of a failed transaction

A payment that fails must say **why**, with the specific cause the wallet/RPC
gave — never only the generic "The payment could not be completed. Review the
details and try again." That fallback is the last resort, not the outcome for a
real provider failure.

Two rules keep it specific:

- `executePlan` must attach the original thrown value to the `ExecutionError`
  it raises (`new ExecutionError(msg, code, stepId, err)`). Dropping it was the
  "returns to Confirm and Send with no explanation" report: the wrapper kept only
  its own fixed sentence, so `classifyTransactionError` saw a bare
  `ExecutionError` and could only fall through to the generic message.
- `classifyTransactionError` must read the **whole `cause` chain** — viem nests
  its errors several levels deep (`BaseError.cause` → provider error → …), and
  `cause` may itself be an object, not just a string. Walk it (bounded) for both
  the message text and the numeric JSON-RPC/EIP-1193 code.

The gas shortfall is checked *before* the generic "insufficient funds" branch,
because wallets phrase the fee failure as `insufficient funds for gas * price +
value`; reading it as a token shortfall would send the user to the wrong remedy.
Both `insufficient_gas` variants surface the one canonical
`INSUFFICIENT_MON_FOR_FEES_MESSAGE`.

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

### The native gas reserve is derived, not a flat 0.01 MON

A *native* MON payment also has to keep its own fee aside. That reserve was a
flat `0.01 MON` in three places (`lib/server/optimizer.ts`, `lib/hooks/usePayment.tsx`,
`lib/execution/signGuard.ts`), so a small native transfer needed
`amount + 0.01 MON` and was rejected when the balance sat between `amount + real
gas` and `amount + 0.01 MON` — the reported "small native MON transfer fails".
On Monad a native transfer is exactly 21,000 gas, so at the ~100 gwei floor the
real fee is ~0.0021 MON (docs.monad.xyz/developer-essentials/gas-pricing); the
flat reserve was ~4–5× that.

`lib/domain/gasReserve.ts` is now the single rule: the reserve is
`gasLimit × maxFeePerGas`, where `maxFeePerGas` is the higher of 1.2× the live
gas price and the Monad base-fee floor (100 gwei) + headroom. All three sites use
`quoteGasReserveWei(quote)`. `STEP_GAS_UNITS.transferNative` is the
protocol-exact `21_000n` (it was an inflated 30,000). A native payment is now
blocked only when it genuinely cannot cover `amount + real gas`.

**There is no minimum transfer amount.** Neither the product nor Monad imposes
one; a tiny amount is valid. The two real constraints — insufficient MON for the
total fee, and no route/liquidity for a conversion — are named honestly and must
never be described as a "minimum". `MIN_EXECUTABLE_LIQUIDITY_USD`
(`lib/domain/tokenRisk.ts`) is a per-token *swap-liquidity* floor, not a payment
minimum, and `Amount is too small to send` (`validateAmount`) only fires when an
amount rounds below one base unit at the token's decimals.

### The app prepares the transaction envelope, not the wallet

The reported Trust Wallet failure — `Failed to connect to
http://monad.twnodes.com/` *after* Confirm and Send — is not a chain read the app
makes. `monad.twnodes.com` is Trust Wallet's **own** NaaS RPC: its in-app-browser
provider answers any method it does not handle natively by proxying to that node
from the page. The app already submits a raw `eth_sendTransaction` with an
explicit `chainId`, so it never triggers that proxy — but it used to omit
`gas`/fees/nonce, leaving the *wallet* to fetch them, and a wallet whose own node
is unreachable cannot.

`lib/execution/prepareTx.ts` is the single rule. `prepareTxFields` reads `gas`
(`estimateGas` + 20%), the EIP-1559 `maxFeePerGas`/`maxPriorityFeePerGas`
(`estimateFeesPerGas`) and, for a multi-step plan, a fresh `nonce` through the
app's **own** `getClientPublicClient` RPC, and `buildSendParams` assembles the
`eth_sendTransaction` object. All three paths — the composer (`executePlan` →
`sendTransactionViaWallet`), the hosted checkout (`sendCallsSequentially`) and
the SDK's `Wallet.sendCalls` (which forwards caller-supplied envelope fields) —
use it, so the wallet is asked only to approve, sign and broadcast.

Rules: every read is best-effort and **total** — a field whose read fails (or a
client missing the method) is **omitted**, never fabricated, and preparation must
never be the reason a payment cannot proceed. The nonce is re-read fresh per call
so a sequential plan cannot reorder. The gas buffer is a real cost because Monad
charges the gas **limit**; it stays at 20% to match `coversGas`. The calldata,
sender, recipient, value and on-chain output bound are unchanged.

**Honest boundary:** this removes the reads a wallet performs *before* signing.
Trust Wallet's native broadcaster may still use its own node to broadcast; that
layer is closed source and cannot be inspected or configured from a dApp, so a
physical Android Trust Wallet test is the only way to confirm the last step.

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

## A submission is sent exactly once (never retried)

`sendTransactionViaWallet` (`lib/wallet/sendTransaction.ts`) submits the raw
`eth_sendTransaction` through `walletClient.request`. viem's transport default is
`retryCount: 3`, and it retries a **transport-shaped** failure — the exact shape
a Trust Wallet provider throws when it cannot reach its own node
(`Failed to connect to http://monad.twnodes.com/ …:443`). Without an explicit
`{ retryCount: 0 }` the same `eth_sendTransaction` is issued up to **four times**:
the wallet re-prompts the user and the same payment can be broadcast more than
once. **A transaction submission must never be retried** — every viem wallet
action that signs or submits (`sendTransaction`, `sendRawTransaction`,
`signMessage`, `sendCalls`, …) passes `retryCount: 0` for this exact reason, and
this raw `request` path replaced one of those (`writeContract`), so it must carry
the same rule. A viem-level retry is only safe for idempotent *reads*. The hosted
checkout and the SDK use the bare EIP-1193 provider (`lib/wallet/sendCalls.ts`,
`packages/sdk/src/wallet/connect.ts`) and are outside viem's retry layer.
Regression: `tests/trustSendPreparation.test.ts` (a wallet transport failure must
call `eth_sendTransaction` once).

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

### The customer checkout confirms each step too

`executePlan` is the composer's path. The hosted customer page
(`components/checkout/CheckoutClient.tsx`) broadcasts through the raw provider
(`eth_sendTransaction`) and had its **own** loop — which sent every call
back-to-back with no receipt wait. A swap checkout (a merchant intent whose
`payToken` differs from `receiveToken`) is several transactions
(approve → swap → unwrap → deliver); the swap executed before its approval was
mined and reverted, so the customer paid gas and the order could never settle.

`lib/wallet/sendCalls.ts` (`sendCallsSequentially`, pure) is now the single rule
for that path: send one call, wait for its receipt, and only then send the next.
A rejected/failed/invalid-hash send, an unobserved receipt (`unconfirmed`) or a
reverted receipt stops the run and returns **the hashes already broadcast**, so
the page records them and offers a status check rather than losing the
transaction. The page keeps its own `recordSubmitted` (best-effort submit +
`load()`), mirroring `executePlan`'s "never resubmit automatically" rule. Do not
collapse this back into a fire-and-forget loop.

`SuccessScreen` only reads "delivered" when `delivery.verified` is true; an
unverified delivery reads "sent / broadcast, delivery not yet proven".

### An unknown outcome is recovered from evidence, never from a nonce

The post-authorisation failure (the wallet authorised — the user entered their
password — and *then* its native layer reported it could not reach
`monad.twnodes.com`) leaves the outcome **unknown**: the wallet is asked to send
only after authorisation, so it may already have broadcast. PR #47 stopped
calling that a failure, but its recovery leaned on two nonce heuristics that are
**clues, not proof**: an advanced pending nonce was read as "this payment was
broadcast", and an unchanged one as "nothing was sent". Neither is sound — an
unrelated transaction on the account advances the nonce, and `pending` is a
per-node mempool view, not a chain fact.

`lib/domain/recovery.ts` (`recoverSubmission`, pure) is now the single rule. It
reads evidence through Intent Pay's **own** RPC endpoints
(`lib/execution/recoveryClient.ts`, one independent client per configured
endpoint — never the wallet's provider, whose node is exactly what failed) and
classifies one honest outcome:

- `CONFIRMED` / `REVERTED` — a receipt for a hash we hold. Proceeds to
  `verifyDelivery` / reports the revert.
- `SUBMITTED` — a hash is visible but not yet mined. Keep it; never resubmit.
- `SUBMISSION_UNKNOWN` — the reads cannot establish what happened. Retry stays
  **disabled**.
- `DEFINITIVE_FAILURE` — an explicit rejection or an established pre-submission
  failure. **The only state that re-enables Retry / Pay.**

`matchCandidate` matches a candidate transaction field-by-field against the
attempt identity the app captured just before signing (`to`, `value`, calldata,
nonce); a disagreement is `conflict` (an unrelated tx), a field it cannot read is
`unknown` — never a false `match`. A nonce is used for corroboration only and
**never decides the outcome**; an advanced nonce is reported as un-attributable
activity (`ACTIVITY_ADVANCED_MESSAGE`), not as SUBMITTED.

Both the composer (`UnresolvedPanel`) and the hosted checkout use this one
engine, so their copy (`PAYMENT_STATUS_NEEDS_CHECKING_TITLE`,
`SUBMISSION_UNKNOWN_MESSAGE`) cannot drift. The status check is read-only: it
never signs, never broadcasts and never resubmits. Regression:
`tests/recovery.test.ts`, plus the composer/checkout component cases.

## Actionable transaction errors

`lib/domain/transactionError.ts` (`classifyTransactionError`, pure) maps any
thrown value — a viem `ExecutionError`, an EIP-1193 code, or a raw provider/RPC
string — to a fixed, user-safe `{ kind, message, mayHaveSubmitted, action? }`.
The raw provider string is never shown. `mayHaveSubmitted` (submitted, RPC
failure) means the tx may already be on-chain and must not be retried blindly;
it is fed into the payment diagnostic. Add new provider phrasings here, not in
the component.

### The fee shortfall has its own message

`INSUFFICIENT_MON_FOR_FEES_MESSAGE` is the one copy shown when the sender has
enough MON for the transfer amount but not for the amount *plus* its required
maximum gas fee. It is deliberately distinct from a generic "Transaction error"
and prints no fee figure (so it can never be a misleading estimate).

It is reached by exactly three established paths and nothing else:

- `classifyTransactionError` for a thrown `insufficient funds for gas …` — kind
  `insufficient_gas`.
- `computeReadiness` when the composer's `sufficiency.cause === "fees"`
  (`lib/hooks/usePayment.tsx` sets it only when the native balance covers the
  amount but not the amount + `quoteGasReserveWei`).
- `computeReadiness` when `gasSufficiency.status === "insufficient"` — the
  plan-wide fee shortfall (a swap is several transactions).

All three return `INSUFFICIENT_MON_FOR_FEES_MESSAGE` verbatim; `signGuard`'s
`insufficient_gas` blocked message and `readiness` both import the constant, so
the copies cannot drift. `withFeeShortfallMessage` swaps the same copy onto a
readiness result **without changing its `code`** — the gate stays
`insufficient_gas` and Confirm stays blocked. A `requiredMon` figure is never
printed inside the message (one shortfall, one explanation).

`sufficiency.cause === "amount"` (the balance cannot cover the transfer amount
itself) is an ordinary `insufficient_balance` and must never show this message.
Unrelated failures — wallet rejection, RPC timeout, unsupported asset, invalid
recipient, no route, reverted tx — keep their own message.

`isFeeShortfall` is the single predicate that decides when the copy may be
shown (a `fees`-cause shortfall, or the plan-wide `gasSufficiency` shortfall).
Both the primary (red) and secondary (amber) composer warnings key off it, so
they cannot drift and neither shows a detail-bearing fee estimate.

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

## Concurrency & shared state

There is **no per-user server session**. The canonical intent lives in the
browser (`PaymentProvider` context + `canonicalIntent`); every server handler is
a stateless function of its request body. The only process-wide state is
provider *caching* in `lib/server/*` and `getRoutingProvider()`, and it must
never carry a user identity.

- **Caches are keyed by user-supplied identity, never by a global.** Balances
  (`/api/balances`), tokens (`/api/tokens`), quotes (`/api/quote`) and the
  optimizer (`/api/optimize`) compute per request; the address lives only in the
  request URL/body. `Zerion` and the token/price `TtlCache`s key on the address
  or pool address.
- **In-flight de-duplication is the rule for expensive shared work.**
  `TtlCache` and `tokenList.getCatalog()` coalesce concurrent misses; the
  routing provider's pool-graph build and per-token price now do too
  (`graphInflight` / `priceInflight` in `lib/providers/uniswapV3.ts`). Without
  it, a burst of *cold* callers each rebuilt the graph / re-priced, multiplying
  external RPC calls by the concurrency. Regression: `tests/concurrentRouting.test.ts`.
- **Client races are version-guarded.** `createLatestGuard` + an
  `AbortController` ensure a slow quote/optimizer result can never overwrite a
  newer request's state (`lib/domain/latest.ts`). Regression:
  `tests/concurrency.test.ts`.
- **Any new cache must not be used in the signing path for mutable state.**
  `prepareSigning` fetches *fresh* balances and a *fresh* quote immediately
  before signing, so a short-lived cache (≤ the quote TTL) may back the
  review UI, but never the authorization build.
- **Concurrency do NOTs:** no module-level mutable state keyed by user identity,
  no `localStorage`/cookie session, no per-process "current user". A cache value
  must be a pure function of its key.


## Testing the flow


`/api/quote` accepts a JSON body and is the fastest way to exercise routing
without a wallet:

```bash
curl -s -X POST http://localhost:3000/api/quote -H 'Content-Type: application/json' \
  -d '{"recipient":"0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4","receiveToken":"USDC","receiveAmount":"5","amountMode":"recipient_receives","payToken":"USDT","mode":"live","network":"mainnet"}'
```


## Security hardening (headers, CSP, error disclosure)

- **Security headers ship from `next.config.mjs` `headers()`.** Every route gets
  `Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` and `Cross-Origin-Opener-Policy: same-origin-allow-popups`
  (popups allowed for wallet flows, window object never shared). `/api/*`
  additionally sets `Cache-Control: no-store` — balances/quotes are per-user and
  must never be stored by a shared cache.
- **The CSP is scoped, not generic.** No third-party script origins. `connect-src`
  is `'self'` + the browser RPC origins derived from `NEXT_PUBLIC_MONAD_RPC_URL` /
  `NEXT_PUBLIC_ALCHEMY_API_KEY` (+ `chrome-extension:`/`moz-extension:` for the
  injected provider). `img-src` allows `raw.githubusercontent.com` for the
  official Monad token-list logos. `script-src` keeps `'unsafe-inline'` (Next's
  inline bootstrap) and adds `'unsafe-eval'` **only in development**. If you add
  a provider/logo origin, add it to the matching directive or it will be blocked.
- **Never return a raw upstream error message to the client.** A viem
  `HttpRequestError` embeds the full request URL — including an API-key-in-path —
  and these messages land in API error bodies. Every route that echoes a caught
  error uses `sanitizeUpstreamError(err, fallback)` (`lib/server/http.ts`): it
  collapses URLs to their origin, truncates to 200 chars and never returns a
  stack. `lib/server/diagnostics.ts` scrubs the same way and masks key suffixes
  to the last 2 chars (`…su`).
- Regression tests: `tests/security.test.ts` (sanitiser) and
  `tests/securityHeaders.test.ts` (header/CSP shape, dev vs prod).


## Site metadata, icons and crawl resources

- **`lib/config/site.ts` is the single source for the canonical origin** and the
  list of public routes. `app/layout.tsx` metadata (`metadataBase`, canonical,
  Open Graph, Twitter), `app/robots.ts` and `app/sitemap.ts` all read it, so the
  three cannot drift. `NEXT_PUBLIC_SITE_URL` overrides the default
  (`https://intent-pay-roan.vercel.app`) for a self-hosted deploy.
- **Icons and social images are static files in `app/`** (Next file conventions):
  `favicon.ico` (multi-size PNG-compressed), `icon.svg`, `apple-icon.png`,
  `opengraph-image.png`, `twitter-image.png`. They are rasterised from the vector
  sources `app/icon.svg` and `assets/brand/opengraph-image.svg` by
  `node scripts/generate-brand-assets.mjs` (uses the `sharp` that ships with
  Next). **Never add an `opengraph-image.svg`/`twitter-image.svg` under `app/`** —
  a same-named file convention conflicts with the explicit PNG and the route
  fails to build; the source SVG lives in `assets/brand/`.
- **`robots.txt` disallows `/api/`** (per-user wallet data) and advertises the
  absolute sitemap; `sitemap.xml` lists only real pages. Regression:
  `tests/metadata.test.ts` also asserts every advertised route resolves to an
  on-disk `page.tsx`.
- The CSP's `img-src` already allows `'self'` and `data:`, so these same-origin
  icons/PNGs need no CSP change. `manifest-src 'self'` is present if a web
  manifest is added later.


## Presentation & navigation (one header, one footer, one story)

- **`components/landing/SiteHeader.tsx` is the only site header.** The app
  (`AppShell`) and every docs page (`DocsShell`) render it, so the primary
  navigation (Product · Developers · Merchants · Documentation) and the logo
  cannot drift between routes. `DocsShell` and the top-level pages are **server
  components** — they must stay static and directly navigable (shareable,
  bookmarkable, refreshable). The header is a client component (it reads the
  pathname and toggles the mobile menu); the app passes the wallet
  `ConnectButton` as the `actions` slot, the docs pages pass a plain "Open the
  app" link (they have no wallet provider).
- **Top-level product routes** are `/product`, `/developers`, `/merchants` —
  static pages that explain the product and link to the working surfaces. They
  use `components/landing/MarketingShell.tsx` (header + page header + footer).
  `/product` reuses the shared `Lifecycle` section (`components/landing/HomeSections.tsx`)
  so the homepage and the product page cannot describe a different lifecycle.
- **Every advertised route lives in `PUBLIC_ROUTES` (`lib/config/site.ts`).**
  `app/sitemap.ts` and `tests/metadata.test.ts` read it; a new page must be added
  there and must resolve to an on-disk `page.tsx`. Regression:
  `tests/siteNavigation.test.tsx` (primary nav, active-route, mobile menu) and
  `tests/documentation.test.ts` (routes exist and are discoverable).
- **Nothing on these pages may over-claim.** A capability is stated only if it
  exists in the repository; planned work is labelled planned; the payment
  milestone is described as owner-confirmed (no transaction hash is published).

## Repository documentation & AI discoverability

- `docs/` is the repository-level technical record (`index`, `vision`, `product`,
  `architecture`, `security`, `developers`, `merchants`, `roadmap`), joined by
  `CHANGELOG.md` and `CONTRIBUTING.md`. The in-app docs at `/docs` are the
  user-facing equivalent; the two describe the same system.
- **`llms.txt` exists in two places and must stay byte-identical**: the
  repository root (for readers) and `public/llms.txt` (served at `/llms.txt`).
  `tests/documentation.test.ts` asserts the two copies match and that every
  relative link in `llms.txt` resolves to a real file. Edit the root copy, then
  re-copy it to `public/`.
- `AGENTS.md` remains the place for invariants addressed to any agent or
  contributor; the `docs/` set is prose for humans and integrators.


## Dependency override (postcss)

- `package.json` pins `overrides.postcss` (and the direct devDependency) to
  `^8.5.23`, the first release fixing GHSA-qx2v-qp2m-jg93 / GHSA-6g55-p6wh-862q /
  GHSA-fxqj-rqcc-2cmp / GHSA-r28c-9q8g-f849. Next 15.5.27 pins `postcss@8.4.31`
  exactly (nested); the override dedupes it to a patched 8.5.x. **This is a
  documented override, not a Next major upgrade** — keep it until Next ships a
  15.x patch that bumps postcss itself. Re-run `npm audit --omit=dev` after any
  Next bump to confirm the override is still needed.


## Node.js runtime floor (Brotli RCE)

`package.json` `engines.node` is `>=24.22.1 <25`. That floor is not cosmetic: it
is the first Node.js 24.x release containing the fix for **CVE-2026-111497**,
the Brotli decoder out-of-bounds write that permits remote code execution
(HIGH, reported by Matteo Collina, fixed by Antoine du Hamel). It affects every
22.x / 24.x / 26.x release before v22.23.4 / v24.22.1 / v26.12.1. The official
announcement is
<https://nodejs.org/en/blog/vulnerability/october-2026-security-releases>.

The fix is a cherry-pick of upstream brotli commit `0ed4268a4401abcb44720963`
("Detect and report invalid stream earlier"): `DecodeBlockTypeAndLength` changes
from returning `BROTLI_BOOL` to returning a `BrotliDecoderErrorCode` so an
invalid stream is reported instead of proceeding. **Node does not bump the
bundled brotli version string for this fix** — `deps/brotli/c/common/version.h`
still reports `BROTLI_VERSION 1.2.0` in v24.22.1. So a version-string or
`process.versions.brotli` check is *not* sufficient to tell a fixed build from a
vulnerable one; compare the **Node.js version** against the fixed list.

The local development runtime must therefore be **24.22.1 or newer**; v24.21.0
(the container image this was audited in) is vulnerable and ships the
`BROTLI_BOOL` form of the function.

**Vercel rolls the patch, the repository only sets the floor.** Production runs
on Vercel's managed Node.js runtime. Vercel documents that "Only major versions
are available. Vercel automatically rolls out minor and patch updates when
needed, such as to fix a security issue."
(<https://vercel.com/docs/functions/runtimes/node-js/node-js-versions>). So no
repository edit can pin the deployed *patch* — it can only declare the major
line and the minimum acceptable patch, and Vercel selects the concrete build.
Confirm the deployed version from the Vercel deployment (build log `node -v`, or
`process.version`) rather than assuming the floor was honoured. If Vercel is
serving a 24.x build older than 24.22.1, that is a provider-side action, not a
repo change: re-deploy so the project picks up the current 24.x build, or open a
support case.

The production deployment is *older than the patch*. `dpl_41dujBaRF8rNA8bmNAzF3UhgxdP7`
(the build behind `intent-pay-roan.vercel.app`) was created 2026-10-20 from commit
`78f99c0`; the Node.js security release shipped 2026-10-21. Vercel's
`engines` table maps any valid 24-range to the *current* 24.x build, so the fix
only lands on the next deployment — an existing deployment keeps the runtime it
was built with. The `engines.node` floor is therefore necessary but not
sufficient: it must be paired with a re-deploy to take effect.

## PHP is not part of this stack (CVE-2026-109618 / CVE-2026-109619)

Two critical, unauthenticated-RCE PHP CVEs were published by the PHP CNA on
2026-10-21 (fixed in 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35). They are real, but they
are **not applicable here**: Intent Pay is a Next.js/TypeScript application on
Vercel's managed Node.js runtime, and the repository contains no PHP — no `.php`
/ `.phtml`, no `composer.json` / `composer.lock`, no `php.ini`, no Apache /
PHP-FPM / FrankenPHP / LiteSpeed layer, and no container or CI manifest that
could introduce one. `next.config.mjs` and Vercel's static build pipeline are the
only deployment inputs. The CVEs affect PHP installations that serve web
requests, which this project does not operate. Re-check only if a PHP-backed
service is ever added (for example a CMS or a payment webhook receiver).


## Store durability is a configuration fact, not an adapter property

`lib/store/*` is the single server-side persistence contract (referral
attribution, payment-attempt correlation, ops events, AI cost accounting). Three
adapters share the same schema and integrity rules (`lib/store/schema.ts`):
`MemoryStore` (tests / honest fallback), `SqliteStore` (`node:sqlite`) and
`PostgresStore` (managed Postgres — Neon). A record is plain JSON and must never
carry a key, signature or auth token.

The `Store` interface is **asynchronous** (every method returns a Promise). A
remote database cannot be queried synchronously, and a fake blocking bridge
would be unsafe under serverless concurrency, so the whole interface is async and
the local adapters resolve immediately. Transactions are **serialized** per
adapter (`txChain`) because an async transaction body yields the event loop:
`node:sqlite` has a single connection, so two concurrent `BEGIN`s would throw.

Durability is about the *configuration and a real probe*, not the adapter:

- Backend selection: `DATABASE_URL`/`INTENT_PAY_DATABASE_URL` → Postgres;
  else `INTENT_PAY_DB_PATH` → on-disk SQLite; else a temp-dir SQLite file or
  memory. Only Postgres is genuinely durable on Vercel.
- `storeCapability()` performs a real round-trip (`health()`: a trivial query
  plus a `_migrations` version check) and returns `{ kind, durability, durable,
  reachable, schemaReady, schemaVersion, reason }` with `durability` one of
  `memory` / `ephemeral` / `persistent`. **A configured URL is NOT durable
  storage**: an unreachable or un-migrated database is `ephemeral` with a reason.
- `requireDurableStore()` is the guard for operations that are meaningless if
  forgotten. Referral endpoints (`/api/referral/{attribute,me,qualify}`) call it
  and **refuse with 503 `storage_unavailable`** when the store is not durable —
  never report an ephemeral success. `/api/referral/availability` is the public,
  non-sensitive probe the UI reads before asking for a signature.
- `/api/capabilities.storage` reports `{ kind, durability, durable, reachable,
  schemaReady, schemaVersion, requiredSchemaVersion, referralAttribution,
  reason }` and **never a path or credential**. Payment execution never depends
  on the store, so a store outage cannot block a payment.
- Postgres migrations are versioned and derived from the shared schema
  (`lib/store/migrations.ts`, `SCHEMA_VERSION`); they run lazily/idempotently on
  the first probe. SQL is always parameterized; identifiers are quoted. A
  configured-but-unreachable database makes `verifySession` fall back to a
  per-process secret (still unforgeable) rather than throwing.
- Connecting a wallet must **not** raise a `personal_sign` prompt. The referral
  session signature is only requested from an explicit user action
  (`useReferral().authenticate`, driven by the ReferralPanel button); an existing
  session is adopted silently.

Regression coverage: `tests/storageDurability.test.ts`,
`tests/referralPersistence.test.ts`, `tests/storeMigrations.test.ts`,
`tests/referralPanel.test.tsx`, `tests/phase2Auth.test.ts`.
