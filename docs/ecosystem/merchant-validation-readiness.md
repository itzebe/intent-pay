# Merchant validation readiness

How a real merchant order can be validated safely, and what the agent may and
may not do. The agent does **not** perform a real Mainnet payment.

## What the agent can do (already done)

- Exercise the whole lifecycle against a **local** server with a real database
  and real chain reads, without signing or broadcasting anything.
- Run the production HTTP smoke tests (routes respond; content is served).
- Verify the developer and merchant surfaces serve the documented behaviour.
- Run the automated integration suite (intents, checkouts, webhooks,
  verification, idempotency, replay protection).

## What requires the owner (explicit authorization)

- A **real Mainnet payment** — creating, signing, broadcasting and settling an
  actual on-chain transfer with real value.
- Registering a **production watch-only xpub** for checkout-bound attribution.
- Any action on a real merchant's wallet or funds.

## Safe validation plan (no real payment)

1. **Local lifecycle.** Start the app with a durable local store; create an
   intent, wrap it in a checkout, prepare the calls, and verify that
   `prepare` returns a well-formed plan with a real `amountOutMinimum` and a
   plan-wide gas figure. Nothing is signed.
2. **Verification logic.** Feed a known confirmed receipt through
   `verifyDelivery` and confirm a delivery below the enforced minimum is reported
   `unverified`/`partial`, never success.
3. **Idempotency + replay.** Repeat a create with the same key (same order); submit
   the same hash twice (not double-counted).
4. **Attribution.** Confirm that without an xpub the checkout is reported
   `shared_recipient`, and that the capabilities endpoint says so honestly.
5. **Failure honesty.** Force `route_unavailable` and confirm the checkout fails
   with that code — no fabricated quote.
6. **Production smoke.** Confirm the deployed routes respond and the merchant and
   developer pages render the documented content.

## Acceptance checklist (for the owner's real validation)

- [ ] Operator provisions a production API key for the merchant.
- [ ] (Optional) Operator registers the merchant's watch-only xpub; a checkout
      shows a unique destination and the mode reads `checkout_bound`.
- [ ] Merchant creates a checkout for a small, real amount in the token the
      merchant wants to receive.
- [ ] A customer with a different asset opens the payment link/QR and completes
      the payment in their own wallet.
- [ ] The transaction is confirmed on Monad; `GET .../evidence` re-verifies live.
- [ ] The merchant sees the order settle; the webhook (if configured) is
      delivered with a valid HMAC signature.
- [ ] The record is reconciled: expected amount vs. verified delivery.

## Success criteria

A real merchant order is **validated** only when a real customer payment settles
on Monad Mainnet and independent verification proves the merchant received the
expected asset. Everything short of that is a rehearsal.

## Notes

- Mainnet only: there is no sandbox, so a rehearsal that avoids signing is the
  only safe pre-production step for the agent.
- No refunds exist; the validation amount should be small and intentional.
