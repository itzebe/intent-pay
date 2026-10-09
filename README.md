# Intent Pay — intent-based payments on Monad

**Tell Intent Pay what you want to pay. Review the route. Send on Monad.**

Intent Pay is an intent-based payment layer for Monad. You choose who receives,
how much they should receive, and which token they should receive — the app
figures out which asset you should spend, how much of it is required, the
available conversion route, and the transaction execution.

It is not a swap interface. The user's mental model is a payment, not a trade.

## How it works

1. **Recipient** — paste a wallet address; it is validated and shortened.
2. **What should they receive?** — enter a dollar amount and pick the receive
   token (`MON`, `USDC`, `USDT`, `SOL`, `WETH`, `AUSD`).
3. **How will you pay?** — the app inspects your supported balances and
   recommends the best funded asset, while still letting you choose another.

Everything recalculates live: amount, receive token, payment token, and
recipient.

Two intent modes:

- **Recipient receives** (default) — you fix what they get; we price what you pay.
- **I spend** — you fix what you pay; we show what they receive.

## Architecture

```
Intent layer            lib/domain/intent.ts, lib/domain/validation.ts
Wallet / balance layer  lib/hooks/useWallet.ts, app/api/balances
Quote / routing layer   lib/providers/*, lib/server/quote.ts
Construction layer      lib/execution/plan.ts, lib/execution/abis.ts
Execution layer         lib/execution/execute.ts
Verification layer      lib/providers/uniswapV3.ts (on-chain quotes)
```

The routing provider is swappable: `DemoProvider` (deterministic, clearly
labelled sample data) and the live Uniswap V3 provider share one interface, so
the UI never changes when the backend does.

Tokens, chains, and Uniswap deployments all come from configuration
(`lib/config/tokens.ts`, `lib/config/chains.ts`, `lib/providers/constants.ts`).
No token-specific code paths.

## Demo vs live

- **Demo mode** uses deterministic sample data and is labelled everywhere. No
  transaction hash is ever shown, because no transaction is sent.
- **Live mode** reads real Monad balances and quotes real Uniswap V3 routes on
  Monad mainnet (chain id 143). Nothing is fabricated: unavailable routes fail
  honestly with a `route_unavailable` result instead of a fake quote.

Demo mode also exposes a labelled *Simulate price move* control so the
exact-payment protection can be demonstrated without a live transaction.

## Natural-language intents

Alongside the form, you can describe the payment in plain English — for example
`Send $10 worth of MON to 0xABC…`, `Send 10 MON`, or `Send $10`. The Intent
Engine extracts recipient, amount, and asset, asks only for whatever is
missing, and then hands the completed fields to the **same** composer (same
quote, routing, review, and approval flow).

- Parsing is deterministic and works with no AI provider configured. An optional
  LLM may only fill gaps; it can never supply a price, route, address, or
  transaction.
- `$10`, `10 MON`, and `$10 worth of MON` are treated differently on purpose.
- A name without an address is never turned into an address; the app asks for
  the real address.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest
npm run build
```

Environment (optional):

```
MONAD_RPC_URL=https://rpc.monad.xyz
# Optional AI-assisted intent parsing (the app works without it):
INTENT_LLM_API_KEY=
INTENT_LLM_BASE_URL=https://api.openai.com/v1
INTENT_LLM_MODEL=gpt-4o-mini
```

## Gas

Gas is always paid in native MON by the user's own injected wallet. There is no
sponsored, ERC-20 or account-abstracted gas path — an earlier EIP-7702 /
paymaster experiment was removed because it could not be demonstrated to
complete a real end-to-end payment on Monad. Intent Pay is not a gasless
product, and it does not claim to be.

## Documentation

The docs live under `/docs` and are reachable from the **Learn** menu:

- `/docs` — hub / overview
- `/docs/litepaper` — the full design and status document
- `/docs/how-it-works` — the payment journey, step by step
- `/docs/architecture` — layers, routing and execution
- `/docs/security` — guards, bounds and honest limits
- `/docs/roadmap` — built, in progress, planned
- `/docs/faq` — direct answers
- `/docs/developers` — repo layout, routes and configuration
