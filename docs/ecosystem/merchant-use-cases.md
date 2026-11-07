# Merchant use cases

How payment requests, checkout, links, QR and verification support real business
workflows. Every capability named here exists; limitations are stated plainly.

## The merchant flow

1. **Create the payment request.** A merchant creates an intent (recipient,
   amount, token the merchant wants to receive) and wraps it in a checkout.
2. **Share the checkout.** The customer gets a payment link or QR that opens
   `/checkout/{token}`.
3. **The customer pays with their own wallet.** They may hold a different asset;
   Intent Pay routes it so the merchant still receives the requested token.
4. **Verify settlement.** The merchant reads status by API or webhook; settlement
   is proven from the on-chain receipt, not assumed.

## Realistic scenarios

- **Online store checkout.** Create a checkout per order; the customer pays from
  a browser wallet or mobile wallet (WalletConnect). Read status by polling
  `GET /api/v1/checkouts/{id}` or by webhook.
- **In-person QR.** Display the checkout QR; the customer scans and pays. The
  merchant watches the checkout move to a settled state.
- **Invoicing.** Create an intent for the invoice amount and share the link; the
  invoice is settled when verification proves the transfer.
- **Receiving a stablecoin while the customer holds MON.** The merchant asks for
  USDC; the customer pays with MON; the merchant receives USDC.

## Order attribution

- A merchant who registers a **watch-only payment xpub** gets a **unique
  destination per checkout**, so a transfer can only settle the order it was
  created for (checkout-bound attribution).
- Without an xpub, checkouts share the merchant's recipient (weaker). That mode
  is reported per checkout and is never presented as checkout-bound.
- No spend key is ever held: derivation is watch-only from the merchant's xpub.

## What the merchant can rely on

- **Idempotency** — a repeated create with the same key returns the same order.
- **Replay protection** — a submitted hash is not counted twice.
- **Independent verification** — `GET .../evidence` re-verifies live.
- **Signed webhooks** — HMAC-SHA256, so a delivery can be authenticated.

## Honest limitations

- **No refunds.** No refund endpoint exists; an overpayment is reconciled
  manually.
- **No sandbox.** Orders are real mainnet value.
- **Merchant onboarding needs a receive address.** Signup is self-service
  (email-verified), but a merchant still configures a Monad receive address or a
  watch-only xpub before a checkout can settle.
- **Request-driven webhooks.** Add a scheduled drain for production reliability.
- **Delivery depends on a route.** If no route exists for the requested token,
  the checkout fails honestly rather than producing a fabricated quote.

## Onboarding today

Signup is self-service: a developer registers an email, opens the verification
link, and receives a key. For a merchant, a receive address (or a watch-only xpub
for checkout-bound attribution) is configured on the account. An operator can
also provision an account directly with the admin token. A merchant self-service
flow that registers the receive address/xpub in the same UI is planned, not built.
