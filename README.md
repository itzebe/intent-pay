# Intent Pay

**Payment infrastructure connecting payment intentions with blockchain execution.**

Intent Pay is an intent-based payment layer for **Monad** (chain id 143). You state
what the recipient should receive — the recipient, the dollar amount, and the token
— and the system determines which asset you spend, how much of it, the conversion
route, and the transaction. You approve it in your own wallet.

It is deliberately **not** a swap interface. The user's mental model is a payment,
not a trade.

- **Production:** https://intent-pay-roan.vercel.app
- **Documentation:** [`/docs`](https://intent-pay-roan.vercel.app/docs) in the app, and [`docs/`](docs/) in this repository
- **Status:** live on Monad Mainnet; a real payment has completed end to end (owner-confirmed). See the [roadmap](docs/roadmap.md).

---

## The problem

On-chain payments assume the sender already holds the exact asset the recipient
wants. When they don't, the sender is pushed into a trading workflow — pick a
pair, pick a fee tier, reason about slippage, approve, swap, send — and hope the
amount that lands is the amount that was meant. The payment itself is lost inside
a trade, and a broadcast transaction is treated as success even when the
recipient received less than intended.

## The solution

Intent Pay keeps the payment as the unit of work. A deterministic engine reads the
sender's real balances, prices the assets, finds a route, builds a transaction with
a real on-chain output bound, and verifies that the recipient actually received the
token they were promised. The user authorizes one prepared transaction in their own
wallet.

## Features

- **Intent composer** — recipient, amount and receive token, with a
  natural-language bar (`Send $10 worth of MON to 0x…`) parsed deterministically
  and offline.
- **Live routing** — Uniswap V3 on Monad, exact-output and exact-input, every fee
  tier quoted, with an honest `route_unavailable` when no pool exists.
- **Multi-wallet connectivity** — EIP-6963 injected-wallet discovery with a legacy
  fallback, plus WalletConnect mobile and QR wallets when configured.
- **Protected execution** — a real on-chain minimum output on every swap step, a
  signing guard that rebuilds from fresh data and refuses on any change, and a
  price-impact guard.
- **Verified settlement** — the recipient's transfer is proven from the confirmed
  receipt; unverified delivery is never shown as success.
- **Exactly-once submission** — a single approval maps to a single broadcast; the
  submission is never retried.
- **Partial-balance split** — send what you hold and convert the shortfall, each
  leg with its own bound.
- **Merchant checkout** — hosted payment page, payment links, QR codes, per-order
  attribution, webhooks.
- **Developer API + SDK** — a versioned `/api/v1` HTTP API and a TypeScript SDK.

## Architecture

```
Intent layer            lib/domain/intent.ts, lib/domain/validation.ts
Natural language        lib/nlp/*                      (deterministic, offline)
Wallet / balances       lib/wallet/*, lib/hooks/useWallet.tsx, app/api/balances
Quote / routing         lib/providers/*, lib/server/quote.ts
Construction            lib/execution/plan.ts, lib/execution/abis.ts, prepareTx.ts
Execution               lib/execution/execute.ts, lib/wallet/sendTransaction.ts
Verification            lib/execution/verify.ts, lib/execution/signGuard.ts
Developer API / SDK     app/api/v1/*, packages/sdk/*
```

The routing provider is swappable behind `getRoutingProvider`: a deterministic
`DemoProvider` (labelled sample data) and the live Uniswap V3 provider share one
interface, so the UI never changes when the backend does. Tokens, chains and
Uniswap deployments all come from configuration (`lib/config/*`); there are no
token-specific code paths.

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Technology stack

- **Framework:** Next.js 15 (App Router) + React 19 + TypeScript (strict).
- **Styling:** Tailwind CSS with a small design-token set.
- **Chain:** Monad Mainnet, chain id 143, via viem.
- **Routing:** Uniswap V3 on Monad.
- **Wallet:** EIP-6963 injected wallets, legacy fallback, WalletConnect (Reown v2).
- **Data:** Alchemy (RPC transport, market prices), Zerion (wallet intelligence),
  GeckoTerminal / DexScreener (fallback prices).
- **Storage:** managed Postgres (Neon), on-disk SQLite, or in-memory — selected by
  configuration and probed at runtime.
- **SDK:** `@intentpay/sdk` (TypeScript, tsup).

## Monad network

| | |
| --- | --- |
| Network | Monad Mainnet |
| Chain id | 143 |
| Native gas token | MON |
| Routing | Uniswap V3 |
| Explorer | https://monadscan.com |

Intent Pay is Monad-only. It is not a bridge and does not claim cross-chain
delivery. Gas is always paid in native MON — there is no sponsored, ERC-20 or
account-abstracted gas path.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest (unit + component tests)
npm run build    # production build + typecheck

npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # strict typecheck
```

The SDK is a workspace package:

```bash
cd packages/sdk
npm run typecheck
npm test
npm run build
```

> `next dev` and `next build` share `.next/`. Running a build while the dev server
> is live can break its module cache; restart the dev server (or remove `.next`)
> afterwards.

## Environment variables

Every value is optional; the app degrades gracefully and never fakes data when a
provider is missing. Copy [`.env.example`](.env.example) to `.env.local`.

```
# Site
NEXT_PUBLIC_SITE_URL=

# Monad RPC
MONAD_RPC_URL=                        # server reads; defaults to https://rpc.monad.xyz
NEXT_PUBLIC_MONAD_RPC_URL=            # browser reads

# Wallet connectivity
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID= # free from https://dashboard.reown.com

# Providers
ALCHEMY_API_KEY=                      # RPC transport + market prices
NEXT_PUBLIC_ALCHEMY_API_KEY=
ZERION_API_KEY=                       # wallet asset discovery / USD valuation

# Storage (durable referral attribution)
DATABASE_URL=                         # Postgres; else SQLite, else in-memory

# Optional AI-assisted intent parsing (the app works without it)
INTENT_LLM_API_KEY=
INTENT_LLM_BASE_URL=https://api.openai.com/v1
INTENT_LLM_MODEL=gpt-4o-mini
```

See [`.env.example`](.env.example) for the complete, documented list. No secret is
committed to this repository.

## Testing and building

```bash
npm test                                  # app unit + component tests
cd packages/sdk && npm test               # SDK tests
npm run build                             # production build (includes typecheck)
```

Live routing tests are opt-in (`MONAD_LIVE_TESTS=1`) and skipped by default. When a
test touches tokens or a cached provider, use unique addresses/keys per test — the
token registry and `TtlCache` are module-level.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/vision.md`](docs/vision.md) | Vision, problem, audiences, principles, scope and non-goals. |
| [`docs/product.md`](docs/product.md) | Capabilities and the individual, developer and merchant journeys. |
| [`docs/architecture.md`](docs/architecture.md) | Layers, lifecycle, RPC, trust boundaries. |
| [`docs/security.md`](docs/security.md) | Non-custodial principles, submission invariants, disclosure. |
| [`docs/developers.md`](docs/developers.md) | Onboarding, API usage, SDK setup, integration examples. |
| [`docs/merchants.md`](docs/merchants.md) | Checkout integration, status verification, reconciliation. |
| [`docs/roadmap.md`](docs/roadmap.md) | Status by area, with milestone evidence. |
| [`examples/`](examples/) | Runnable quickstart, merchant, merchant-onboarding and headless status/verify examples. |
| [`CHANGELOG.md`](CHANGELOG.md) | Technical milestones. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development and PR workflow. |
| [`AGENTS.md`](AGENTS.md) | The invariants that must not regress. |
| [`packages/sdk/README.md`](packages/sdk/README.md) | SDK reference. |
| [`llms.txt`](llms.txt) | A compact machine-oriented summary. |

The in-app docs at `/docs` (reachable from the **Documentation** menu) are the
user-facing equivalent.

## Security and wallet authority

Intent Pay is non-custodial and never signs on the user's behalf.

- No key, seed phrase or private key is ever requested, held or stored.
- The only path to a signature is `prepareSigning`, which rebuilds everything from
  fresh data immediately before signing and aborts on any change.
- Every swap step carries a real on-chain output bound (the UI's "minimum
  received" is not the protection).
- A submission is sent exactly once and is never retried.
- A broadcast is not success: delivery is proven from the confirmed receipt.

See [`docs/security.md`](docs/security.md) and [`AGENTS.md`](AGENTS.md).

## Project status

- **Live** on Monad Mainnet. A real payment has completed end to end
  (owner-confirmed; see the [roadmap](docs/roadmap.md)).
- **Complete:** payment execution and reliability, the developer API and SDK,
  merchant checkout.
- **In progress:** expanding live-network verification, copy refinement, mobile
  hardening.
- **Outstanding:** additional real-device wallet testing, third-party developer
  integration validation, merchant onboarding.

The full, honest picture is in [`docs/roadmap.md`](docs/roadmap.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: branch from `main`, keep the
change focused, run the typecheck, app tests, SDK tests and build, and state
explicitly whether payment execution behaviour changed. `main` deploys to
production, so a merge is a release.

## Contact

- **Support / security:** jonathanebi05@gmail.com
- **X:** [@IntentPayApp](https://x.com/IntentPayApp)

Report a suspected vulnerability privately rather than in a public issue.

