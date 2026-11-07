# Vision

## What Intent Pay is

Intent Pay is payment infrastructure that connects a **payment intention** with
**blockchain execution**. A user states the outcome — *this recipient receives
this amount of this token* — and the system determines which asset the sender
spends, how much of it, the conversion route, and the transaction that delivers
the result. The user approves it in their own wallet.

It is deliberately **not** a swap interface. The user's mental model is a
payment, not a trade. Copy says "Pay", never "Swap".

## The problem

On-chain payments assume the sender already holds the exact asset the recipient
wants. When they do not, the sender is pushed into a trading workflow: choose a
pair, choose a fee tier, reason about slippage, approve, swap, then transfer —
and hope the amount that lands is the amount that was meant.

Three things go wrong with that:

1. **The outcome is lost.** The payment is expressed as a series of trades, not
   as "the recipient receives $X of USDC".
2. **The risk is invisible.** Slippage, price impact and routing quality are the
   user's problem, and a bad route looks the same as a good one.
3. **It is not verifiable.** A broadcast transaction is treated as success, even
   when the recipient received less than intended.

## Target audiences

- **Individuals** — send someone the token they asked for, paying with whatever
  they already hold.
- **Developers** — integrate payments with a versioned HTTP API and a TypeScript
  SDK, from intent creation to verified settlement.
- **Merchants and businesses** — accept crypto checkout with a link or QR, and
  receive the exact asset they asked for, verified on-chain.
- **Ecosystem partners** — a reference implementation of honest, verifiable
  payment infrastructure on Monad.

## Product principles

1. **Outcome first.** The intent is the payment. Routing is machinery the user
   should not have to reason about.
2. **The user keeps their keys.** Authorization always happens in the user's own
   wallet. Intent Pay never holds a key and never signs.
3. **A broadcast is not a success.** Delivery is proven from the confirmed
   receipt before anything reads "paid".
4. **Exactly-once submission.** A single approval maps to a single broadcast; the
   submission is never retried.
5. **Honest failure over fabricated success.** An unavailable route fails with a
   specific reason. A demo is labelled as a demo. A price with no source is shown
   as unavailable, never as `$0.00`.
6. **State what is real.** Capability surfaces report what is configured and
   reachable now, not what could be.

## Scope

- Monad Mainnet (chain id 143) payments.
- Non-custodial execution through the user's injected wallet or WalletConnect.
- Live Uniswap V3 routing, exact-output and exact-input.
- A versioned developer API and SDK for intents, checkouts, webhooks and
  settlement verification.

## Non-goals

- **Not a bridge.** No cross-chain delivery is claimed or attempted.
- **Not gasless.** Gas is always paid in native MON. There is no paymaster,
  bundler, UserOperation or account-abstraction path.
- **Not a custodian.** No key, seed phrase or private key is ever requested or
  stored.
- **Not a swap UI.** The interface is a payment flow, not a trading terminal.
- **Not a service-fee product today.** No fee is charged; if one is added it will
  be disclosed before authorization.

See [roadmap.md](./roadmap.md) for what is complete, in progress, and planned.
