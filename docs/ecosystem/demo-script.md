# Demonstration script

Follow these scripts with the real product. If a real transaction is not
available for a live demo, say so explicitly and use the walkthrough — never
present a walkthrough as a completed payment, and never manufacture a hash.

## 30–60 second demo (product feel)

1. **The problem (5s).** "A customer wants to pay in USDC but holds MON. Today
   that means a swap, an approve, and a send — three things to get right."
2. **Open Intent Pay (5s).** Land on the composer. "Here you just say the
   payment."
3. **State the payment (10s).** Enter the recipient, the amount, the token the
   recipient receives. "This is an intent — an outcome."
4. **See the route (10s).** The composer reads real balances and finds a route.
   "It picks a funded asset and the best route it can quote."
5. **Review (10s).** Open Review. "Recipient, amount, token, network, and the
   minimum the recipient is guaranteed on-chain."
6. **Authorize (10s).** Connect the wallet and approve. "You approve in your own
   wallet — Intent Pay never holds your keys."
7. **Verify (5s).** Show the confirmed state. "Settlement is proven from the
   receipt, not assumed."

## 2–3 minute technical demo

1. **Frame the lifecycle (15s).** Intent -> preparation -> authorization ->
   submission -> verification. "Five stages; the first two are the system's job."
2. **Intent (15s).** Show that the intent is canonical state, and that a
   token-quantity intent names the recipient's asset, not the source.
3. **Preparation (30s).** Show the plan: approve -> swap -> unwrap -> deliver,
   each swap carrying a real `amountOutMinimum`. Note the gas is priced across
   the whole plan.
4. **Authorization (30s).** Explain the signing guard: it fetches fresh balances
   and a fresh quote, re-reads the intent, and rebuilds the calldata. "If
   anything moved, it refuses — and it will not sign a stale quote."
5. **Submission (20s).** "One approval, one broadcast. It is never retried."
6. **Verification (30s).** Show `verifyDelivery` proving the recipient's transfer
   from the receipt. "Unverified is shown as unverified."
7. **Developer and merchant (30s).** Show `/developers` (five API calls) and
   `/merchants` (checkout, link/QR, attribution, webhooks).

## Presentation outline

1. Problem: the payment is lost inside a trading workflow.
2. Intent Pay: an outcome-first payment layer on Monad.
3. Lifecycle: five stages, one canonical intent.
4. Safety: non-custodial, guarded signing, on-chain bounds, verified settlement.
5. Why Monad: low fees, fast finality, real EVM tooling.
6. Audiences: individuals, developers (API/SDK), merchants (checkout/links/QR).
7. Limits: mainnet only, no refunds, no sandbox, self-service email-verified signup.
8. Ecosystem fit and next steps.

## Questions an ecosystem reviewer might ask

- **Is it non-custodial?** Yes. No key is ever held; authorization is in the
  user's wallet (`credentialCanSign: false`).
- **Does the AI spend from wallets?** No. The natural-language layer is optional
  and can only fill gaps in a deterministic parse; it never signs or sends.
- **How is success proven?** `verifyDelivery` reads the confirmed receipt and the
  recipient's transfer against the enforced minimum. Unverified is never success.
- **What if the route does not exist?** It fails honestly (`route_unavailable`)
  rather than fabricating a quote.
- **Is there a testnet or sandbox?** No. Mainnet only; a `test` key does not
  change the chain.
- **Can it refund?** No refund endpoint exists.
- **Is it cross-chain?** No. Monad only; not a bridge.
- **Is this endorsed by Monad?** No. It is independent infrastructure; no
  partnership, sponsorship or endorsement is claimed.
- **Can a duplicate submission happen?** No. One approval maps to one broadcast;
  submissions are never retried, and unknown outcomes are resolved from evidence.
