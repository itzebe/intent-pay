# Intent Pay — intent-based payments on Monad

**Pay in what you have. Send what they need.**

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
```

## Notes

Gas abstraction is only claimed where the infrastructure supports the exact
wallet and transaction flow. The UI states plainly when a step will require a
wallet approval.
