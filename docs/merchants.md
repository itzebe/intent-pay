# Merchants

This guide is the repository-level merchant onboarding. The in-app reference at
`/docs/checkout` documents the customer routes in detail.

## Onboarding

1. Obtain a merchant API key (`ipk_live_<prefix>.<secret>`). The key is held by
   your server, never on a customer route and never bundled into a browser.
2. Read `GET /api/v1/capabilities` for the real chain, assets and endpoints.
3. Optionally register a **watch-only payment xpub** so each order is paid to a
   unique derived destination (see below).
4. Create an intent, wrap it in a checkout, and share the link or QR.

## The model: an intent, then a checkout

A **checkout** is a payable order bound to a payment intent. You create the intent
first (amount, asset, recipient), then wrap it in a checkout to obtain a public
payment link. Creating the checkout **freezes** the intent's parameters and
authorizes it for payment — the amount, asset and recipient can never change once
a link exists.

- One intent has at most one checkout. A second create returns the original link.
- The public handle is a random `chk_…` token. Only its hash is stored.
- The link expires (default 30 minutes, 60–86400 seconds) and then cannot be paid.

## Checkout integration

```bash
# 1. The payment intent — the recipient receives $25 worth of USDC
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/intents \
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \
  -H "Content-Type: application/json" \
  -d '{"recipient":"0x…","receiveToken":"USDC","amount":"25","amountMode":"recipient_receives"}'

# 2. The checkout — the response's "token" is the payment link handle
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/checkouts \
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \
  -H "Content-Type: application/json" \
  -d '{"intentId":"int_…","orderReference":"ORDER-1001"}'
```

The customer opens `https://intent-pay-roan.vercel.app/checkout/<token>`. The page
carries no credential — the token in the URL authenticates the order.

### Customer routes (public)

Authenticated by the checkout token, not an API key. These are what the hosted
payment page uses, and what a fully custom front end would call.

```
GET  /api/checkout/<token>          the order, its status and any tx hashes
POST /api/checkout/<token>/prepare  build the calls for a sender address
POST /api/checkout/<token>/submit   record the customer's broadcast hash(es)
POST /api/checkout/<token>/verify   independently verify settlement
```

The merchant key can build and verify, but it can never authorize a payment. Only
the customer's own wallet signs and broadcasts.

## Status verification

A submitted transaction is not a payment. The order reaches `payment_verified`
only when `/verify` reads the authoritative Monad receipt and proves the recipient
received the expected amount in the requested asset.

| Verdict | Meaning | Order |
| --- | --- | --- |
| `verified` | The recipient was paid on-chain. | Complete. |
| `pending` / `unconfirmed` | A transaction exists but is not yet confirmed. | Retryable. |
| `not_found` / `unavailable` | No receipt yet, or the node is unreachable. | Retryable; never success. |
| `short` | The recipient received less than intended. | Fails. |
| `reverted` | The transaction failed on-chain. | Fails. |
| `historical` | The transaction predates the order. | Fails. |

## Reconciliation

- **Per-order attribution.** By default every order shares your recipient address,
  so a payment is attributed by token, amount and time guards. Register a
  watch-only xpub and each checkout is paid to a **unique destination** derived for
  that order, so a transfer can only settle the order it was created for:

  ```bash
  curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/attribution \
    -H "Authorization: Bearer ipk_live_…" \
    -H "Content-Type: application/json" \
    -d '{"paymentXpub":"xpub6…"}'
  ```

- **Replay resistance.** One transaction pays one order. A hash is claimed durably
  on `(chainId, txHash)` when settlement is proven; a hash that already paid
  another order is refused with `409 replay_detected`.
- **Settlement evidence.** `GET /api/v1/checkouts/{id}/evidence` returns the
  settlement evidence, re-verified live.
- **Webhooks.** Register endpoints and receive `checkout.created`,
  `checkout.expired` and payment events, with signature verification. Delivery is
  request-driven (a scheduled drain), not a long-running worker.

## What is not built

A transparent service fee is not charged today; if added it would be disclosed
on-screen before the customer authorizes. Fiat off-ramp, automated reconciliation
exports and multi-asset settlement reporting are not implemented.

## Running the example

[`examples/merchant`](../examples/merchant) is a runnable merchant integration:
`node server.mjs` and open the printed URL.
