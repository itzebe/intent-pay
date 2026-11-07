# Architecture

## Overview

Intent Pay is a Next.js (App Router) + TypeScript application with a colocated
TypeScript SDK. It is **non-custodial**: the browser holds no key, the server
holds no key, and every payment is authorized by the user's own wallet.

```
                    ┌─────────────────────────────────────────────┐
                    │                  Browser                    │
                    │  composer · intent bar · review · checkout  │
                    │  canonical intent (single payment state)    │
                    │  wallet provider (EIP-6963 / WalletConnect) │
                    └───────────────┬─────────────────────────────┘
                                    │ HTTP (no credentials on
                                    │ customer routes)
                    ┌───────────────▼─────────────────────────────┐
                    │              Next.js server                 │
                    │  /api/*            stateless handlers       │
                    │  routing provider  Uniswap V3 on Monad      │
                    │  pricing           Alchemy / Gecko / Dex    │
                    │  store             Postgres · SQLite · mem  │
                    └───────────────┬─────────────────────────────┘
                                    │ JSON-RPC (read)  ·  wallet signs (write)
                    ┌───────────────▼─────────────────────────────┐
                    │             Monad Mainnet (143)             │
                    └─────────────────────────────────────────────┘
```

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Intent | `lib/domain/intent.ts`, `lib/domain/validation.ts` | The canonical payment state and its validation. |
| Natural language | `lib/nlp/*` | Deterministic parsing of a sentence into an intent; optional, gap-filling LLM. |
| Wallet / balances | `lib/hooks/useWallet.tsx`, `lib/wallet/*`, `app/api/balances` | Provider discovery, connection lifecycle, real balances. |
| Quote / routing | `lib/providers/*`, `lib/server/quote.ts` | Live Uniswap V3 quoting and route selection. |
| Construction | `lib/execution/plan.ts`, `lib/execution/abis.ts`, `lib/execution/prepareTx.ts` | Plan assembly, calldata, and the transaction envelope. |
| Execution | `lib/execution/execute.ts`, `lib/wallet/sendTransaction.ts` | Sequential submission, exactly-once, receipt confirmation. |
| Verification | `lib/execution/verify.ts`, `lib/execution/signGuard.ts` | Pre-signing guard and post-confirmation delivery proof. |
| Developer API | `app/api/v1/*`, `packages/sdk/*` | The versioned external contract and its client. |

## Frontend, server and SDK responsibilities

- **Frontend (browser).** Holds the canonical intent, discovers wallets, renders
  the composer, review and checkout, and drives the wallet's `eth_sendTransaction`.
  It never holds a merchant API key on a customer route.
- **Server (Next.js route handlers).** Stateless functions of their request
  bodies: quoting, balances, token resolution, optimizer, the NLP parser, and the
  versioned `/api/v1` API. Provider results are cached; no user identity is stored
  in a cache key.
- **SDK (`@intentpay/sdk`).** A server-safe client for the `/api/v1` API, a
  browser wallet layer (`@intentpay/sdk/wallet`) and webhook verification
  (`@intentpay/sdk/webhooks`). The SDK refuses to construct a keyed client in a
  browser: the API key authorizes API calls, the wallet signs, and the two never
  meet.

## Wallet interaction

- **Discovery** is EIP-6963 (`lib/wallet/eip6963.ts`), folding in the legacy
  `window.ethereum` and `window.trustwallet.ethereum`. It is React-free so it can
  be unit-tested against a fake `window`.
- **Lifecycle rules** are pure (`lib/wallet/connection.ts`): an empty account
  list is a disconnect, never a half state.
- **Submission** goes through the user's injected provider. The app prepares the
  envelope (gas, EIP-1559 fees, nonce) so the wallet never has to reach its own
  node to build the transaction.

## Payment lifecycle

1. **Intent** — recipient, amount, receive token. `DEFAULT_INTENT` is empty; a
   hardcoded default is exactly how a stale payment appears.
2. **Preparation** — resolve the source asset, quote the route, build the plan
   with a real on-chain output bound, and assemble the envelope.
3. **Authorization** — `prepareSigning` rebuilds everything from fresh balances,
   a fresh quote, the current intent version and the wallet account; any change
   aborts with a specific reason.
4. **Submission** — steps are sent one at a time, each after its predecessor is
   confirmed, and each is submitted exactly once (`retryCount: 0`).
5. **Verification** — `verifyDelivery` proves the recipient's transfer from the
   confirmed receipt against the plan's slippage bound.

## RPC architecture

- Reads go through a fallback transport over the configured Monad RPC endpoints
  (`lib/config/chains.ts`). A stalled endpoint fails over to the public Monad RPC.
- The browser RPC URL and the server RPC URLs are derived from configuration
  (`NEXT_PUBLIC_MONAD_RPC_URL`, `NEXT_PUBLIC_ALCHEMY_API_KEY`, `MONAD_RPC_URL`).
- In-flight de-duplication coalesces concurrent cold work (pool-graph builds,
  price reads) so a burst of callers does not multiply external RPC calls.

## Trust boundaries

- **Key custody.** None. The user's wallet holds the key and signs; the app never
  sees it.
- **Merchant API key.** Held by the integrator's server, never on a customer
  route, never bundled into the browser.
- **Customer checkout token.** A random `chk_…` handle; only its hash is stored.
  It authenticates the order, not the merchant.
- **Server responses.** A raw upstream error is never returned to a client; URLs
  are collapsed to their origin and messages are truncated.

See [security.md](./security.md) for the invariants and [../AGENTS.md](../AGENTS.md)
for the full list of behaviours that must not regress.
