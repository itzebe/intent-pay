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
- Verification: `lib/providers/uniswapV3.ts`

The routing provider is behind `lib/providers/index.ts` (`getRoutingProvider`).
Demo and live providers implement the same interface; the UI must never branch
on which provider is active beyond the demo/live label.

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

## Testing the flow

`/api/quote` accepts a JSON body and is the fastest way to exercise routing
without a wallet:

```bash
curl -s -X POST http://localhost:3000/api/quote -H 'Content-Type: application/json' \
  -d '{"recipient":"0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4","receiveToken":"USDC","receiveAmount":"5","amountMode":"recipient_receives","payToken":"USDT","mode":"live","network":"mainnet"}'
```
