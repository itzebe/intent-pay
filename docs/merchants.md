# Merchants

How a business accepts an Intent Pay payment, end to end. This is the
repository-level merchant guide; the in-app reference at
[`/docs/checkout`](https://intent-pay-roan.vercel.app/docs/checkout) covers the
customer routes, and the machine-readable capability list is
`GET /api/v1/capabilities`.

Every request, response and error below was taken from a live run of the shipped
API — not sketched.

## 1. Overview

Intent Pay is an intent-based payment layer on **Monad mainnet (chain id 143)**.
You state what the recipient should receive (recipient, dollar amount, receive
token); the customer's own wallet resolves which asset to spend, the route and
the transaction. You receive the exact asset you asked for, and settlement is
proven on-chain before an order is marked paid.

You create a **checkout** — a payable order bound to a payment **intent** — and
share a payment link or QR code. The customer pays on a hosted page with their
own wallet. You never hold a key, and your API key can never authorize a payment.

## 2. Supported merchant use cases

- **Hosted checkout with a payment link** — the primary flow. Create an order,
  share `https://<host>/checkout/<token>`.
- **QR payment** — the same link rendered as a QR code for in-person or
  screen-to-screen payment (`components/checkout/PaymentQR.tsx`).
- **Exact-asset settlement** — request USDC (or any supported token) and receive
  that token, whatever the customer holds.
- **Per-order attribution** — register a watch-only payment xpub and each order
  is paid to a unique derived destination (see §10).
- **Server-driven status and evidence** — poll an order, or fetch re-verified
  settlement evidence, and receive signed webhooks.

## 3. Current capability limitations

These are real limits, stated so the working surface is not over-claimed.

- **No sandbox and no testnet.** Intent Pay is Monad mainnet only. A `test`
  environment API key changes **only** whether the key is accepted outside
  production; it does **not** change the chain or move a "test" payment. Any real
  payment moves real funds. See §14.
- **No refunds.** An overpayment is never refunded automatically, and there is no
  refund endpoint. A `verified` order records the exact amount delivered.
- **Self-serve signup with email verification.** Signup is public: register an
  email, open the verification link, and your first key is issued once. An
  operator can also provision a key directly (the admin path). See §6.
- **Webhook delivery is request-driven.** Events enqueue a delivery row; a due
  attempt is made after a `submit`/`verify` response, after a delivery-log read,
  or via the admin drain route. This deployment has no cron configured — see §12.
- **History is bounded.** `GET /api/v1/checkouts` returns the newest 50.
- **No service fee is charged today.** If one is added it will be disclosed
  on-screen before the customer authorizes.

## 4. Prerequisites

- A **Monad receive address** — where you want to be paid (or a watch-only xpub
  for per-order destinations).
- A **server** to hold your API key. The key must never reach a browser.
- A way to **share a link** (email, SMS, your own web page, or a QR).
- No wallet, node or key custody is required of you.

## 5. Authentication

Every `/api/v1` request is authenticated with a bearer API key:

```
Authorization: Bearer ipk_live_<prefix>.<secret>
```

- The key has the shape `ipk_<environment>_<prefix>.<secret>`, where
  `<environment>` is `live` or `test`.
- Only a salted hash of the secret is stored. The plaintext is returned **once**,
  at creation, and is never retrievable again.
- A **test** key is refused in production unless the deployment sets
  `INTENT_PAY_ALLOW_TEST_KEYS=1`. It does not change the chain.
- The key can **build** and **verify** a payment. It can never **sign** or
  **send** one — that is always the customer's wallet.

## 6. Credential acquisition

Signup is **self-service**: register an email, open the verification link, and your
first key is issued once. No operator is involved.

```bash
# 1. start signup — a verification email is sent to the address
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-shop","email":"you@example.com"}'
# → 202 { "ok": true, "status": "verification_sent", … }

# 2. exchange the token from the email for your first key
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers/verify \
  -H 'Content-Type: application/json' \
  -d '{"token":"ipv_…"}'
# → 201 { "ok": true, "apiKey": "ipk_live_…", "keyId": "key_…", … }
```

- **No credential before proof.** Registration issues **no** key; the key is
  minted only when the verification link is opened, so an address you do not
  control can never obtain one. The verification token is single-use, expires in
  24 hours, and only its hash is stored.
- The response to `/register` is the same whether the address is new, already
  pending or already registered, so the endpoint cannot be used to discover which
  addresses have accounts.
- If the deployment has no email provider configured, `/register` refuses with
  `503 email_unavailable` rather than accepting an account it cannot verify.
- The portal at [`/developer`](https://intent-pay-roan.vercel.app/developer) does
  the same flow in a browser and manages keys (create / rotate / revoke) after
  sign-in.

**Operator provisioning (support / bulk onboarding).** An operator may create an
account directly with the `INTENT_PAY_ADMIN_TOKEN`:

```bash
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers \
  -H "Authorization: Bearer $INTENT_PAY_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-shop","email":"ops@example.com"}'
```

Without the token this endpoint responds:

```json
{ "ok": false, "error": { "code": "forbidden",
  "message": "Operator provisioning requires the admin token. Self-service signup is available at the developer portal." } }
```

`GET /api/v1/developers` returns your account and your keys' metadata (prefix,
label, environment, status) — never a secret.

## 7. Payment creation

Create the intent (what the recipient receives):

```bash
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/intents \
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ORDER-1001" \
  -d '{
    "recipient": "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    "receiveToken": "USDC",
    "amount": "25",
    "amountMode": "recipient_receives",
    "reference": "ORDER-1001"
  }'
```

Real response:

```json
{ "ok": true,
  "intent": {
    "id": "int_w7dqe2yv4cd43igvlw7eznvu",
    "object": "intent",
    "state": "created",
    "chainId": 143,
    "recipient": "0x7a91c4b8e2d9f04ab3c6e81d5f72a0c9e4bd92f4",
    "receiveToken": "USDC",
    "receiveTokenAddress": "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    "amountMode": "recipient_receives",
    "amount": "25",
    "payToken": null,
    "reference": "ORDER-1001",
    "authorized": false,
    "createdAt": "2026-11-07T19:24:19.067Z",
    "updatedAt": "2026-11-07T19:24:19.067Z"
  },
  "created": true }
```

Fields: `recipient` (a valid Monad address), `receiveToken` (ticker or contract
address), `amount` (a string), `amountMode` (`recipient_receives` — the recipient
gets this much; or `i_spend` — the sender spends this much), optional `payToken`
to pin the source asset, optional `reference`.

## 8. Checkout integration

Wrap the intent in a checkout to obtain the payment link:

```bash
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/checkouts \
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ORDER-1001" \
  -d '{"intentId":"int_w7dqe2yv4cd43igvlw7eznvu","orderReference":"ORDER-1001"}'
```

Real response:

```json
{ "ok": true,
  "checkout": {
    "id": "chk_coepkreb7qpruepkiun8en14",
    "object": "checkout",
    "status": "open",
    "phase": "awaiting_payment",
    "intentId": "int_w7dqe2yv4cd43igvlw7eznvu",
    "orderReference": "ORDER-1001",
    "token": "chk_845e043506921a32fe528a96b7d62c6ab93bdd946a7526e9d3c62ca8e42da7d1",
    "tokenHint": "e42da7d1",
    "attribution": { "mode": "shared_recipient", "destination": null, "derivationIndex": null },
    "expiresAt": "2026-11-07T19:54:19.148Z",
    "completedAt": null, "canceledAt": null,
    "createdAt": "2026-11-07T19:24:19.148Z",
    "updatedAt": "2026-11-07T19:24:19.148Z"
  },
  "token": "chk_845e043506921a32fe528a96b7d62c6ab93bdd946a7526e9d3c62ca8e42da7d1",
  "created": true }
```

Share `https://<host>/checkout/<token>`. The page carries no credential — the
token authenticates the order. Creating the checkout **freezes** the amount,
asset and recipient; a second create for the same intent returns the original
link (`created: false`). Optional `ttlSeconds` (60–86400, default 1800).

### Customer routes (public)

Authenticated by the checkout token, never an API key. The hosted page uses
these, and so would a fully custom front end.

```
GET  /api/checkout/<token>          the order, its status and any tx hashes
POST /api/checkout/<token>/prepare  build the calls for a sender address
POST /api/checkout/<token>/submit   record the customer's broadcast hash(es)
POST /api/checkout/<token>/verify   independently verify settlement
```

The merchant key can build and verify; only the customer's wallet signs.

## 9. Payment status retrieval

- `GET /api/v1/checkouts` — list your orders (newest 50).
- `GET /api/v1/checkouts/:id` — one order and its bound intent.
- `GET /api/checkout/<token>` — the customer's public view:

  ```json
  { "ok": true,
    "checkout": { "id": "chk_…", "status": "open", "phase": "awaiting_payment", "…": "…" },
    "phase": "awaiting_payment",
    "txHashes": [] }
  ```

`phase` moves `awaiting_payment` → `transaction_submitted` →
`payment_verified` (or `payment_failed` / `expired` / `canceled`). A submitted
transaction is **not** a payment; the order reaches `payment_verified` only when
settlement is proven on-chain.

## 10. Settlement verification

`POST /api/v1/checkouts/:id/verify` (or the public `/api/checkout/<token>/verify`)
re-reads the authoritative Monad receipt and proves the recipient received the
expected amount in the requested asset. Verdicts:

| Verdict | Meaning | Order |
| --- | --- | --- |
| `verified` | The recipient was paid on-chain. | Complete. |
| `pending` / `unconfirmed` | A transaction exists but is not yet confirmed. | Retryable. |
| `not_found` / `unavailable` | No receipt yet, or the node is unreachable. | Retryable; never success. |
| `short` | The recipient received less than intended. | Fails. |
| `reverted` | The transaction failed on-chain. | Fails. |
| `historical` | The transaction predates the order. | Fails. |

A real `verify` on an order whose hash is not yet on-chain:

```json
{ "ok": true, "verdict": "not_found", "phase": "transaction_submitted",
  "status": "open", "retryable": true,
  "message": "That transaction wasn't found on Monad." }
```

`GET /api/v1/checkouts/:id/evidence` returns the settlement evidence, re-verified
live: the verdict, the transaction hashes, the frozen-parameter match and
`settled`.

### Per-order attribution

By default every order shares your recipient address, so a payment is attributed
by token, amount and time guards. Register a **watch-only payment xpub** and each
checkout is paid to a unique `m/0/<index>` destination instead:

```bash
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/attribution \
  -H "Authorization: Bearer ipk_live_…" \
  -H "Content-Type: application/json" \
  -d '{"paymentXpub":"xpub6…"}'
```

- **Public key only.** A private key (`xprv…`) or seed phrase is refused; Intent
  Pay can never spend. The xpub is never returned by the API.
- Each checkout reports `attribution.mode` — `checkout_bound` (a unique
  destination) or `shared_recipient`. The two are never presented as equivalent.
- **You sweep.** Derived addresses are ordinary receive addresses; collect them
  with the wallet holding the matching seed.
- Not retroactive: registering or replacing an xpub affects only later checkouts.

### Replay resistance

One transaction pays one order. A hash is claimed durably on `(chainId, txHash)`
when settlement is proven; a hash that already paid another order is refused with
`409 replay_detected`.

## 11. Idempotency

Send an `Idempotency-Key` header (or a body `idempotencyKey`) on a create. A
retried create returns the **original** object with `created: false`, never a
duplicate. The key is unique per developer. Reusing a key with a different body
is refused with `409 idempotency_conflict`.

## 12. Webhooks

Register a destination:

```bash
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/webhooks \
  -H "Authorization: Bearer ipk_live_…" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/hook","events":["checkout.created","payment.verified"]}'
# → { "ok": true, "webhook": {…}, "secret": "whsec_…" }   (secret shown once)
```

Every delivery is signed with the destination's own secret:

```
X-IntentPay-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>
```

where the signed message is `` `${t}.${rawBody}` ``. Verify the HMAC **and**
reject a `t` outside a 300-second tolerance — that is what stops a captured
payload being replayed later. The `eventId` is stable across a delivery's
retries and is the duplicate-delivery guard. Use `verifyWebhookSignature` from
`@intentpay/sdk/webhooks`; it implements exactly this rule.

Events: `intent.created`, `intent.validated`, `transaction.prepared`,
`transaction.submitted`, `transaction.confirmed`, `payment.verified`,
`payment.failed`, `payment.rejected`, `intent.expired`, `checkout.created`,
`checkout.expired`, `payment.submitted`, `payment.confirmed`.

Retries follow a fixed schedule (`10, 60, 300, 1800, 7200` seconds; six
attempts). Delivery is **request-driven**: a due attempt happens after a customer
`submit`/`verify`, after a merchant reads a delivery log, or via
`POST /api/v1/webhooks/drain` (admin token). This deployment has no cron, so a
failed final attempt is retried on the next such trigger, not on a timer. A
production merchant should add a scheduled drain (`vercel.json` `crons` calling
the drain route, or any external scheduler).

## 13. Error handling

Every failure is a stable code with a short, client-safe message:

```json
{ "ok": false, "error": { "code": "invalid_request",
  "message": "`amountMode` must be `recipient_receives` or `i_spend`.",
  "detail": "amountMode", "requestId": "…" } }
```

Codes: `invalid_request` (400), `unauthorized` (401), `forbidden` (403),
`not_found` (404), `conflict` / `idempotency_conflict` / `invalid_state` /
`replay_detected` / `already_submitted` (409), `expired` (410),
`invalid_recipient` / `invalid_amount` / `invalid_chain` / `unsupported_token` /
`route_unavailable` / `insufficient_balance` (422), `rate_limited` (429),
`storage_unavailable` (503), `provider_error` (502), `internal_error` (500). A raw
upstream message is never returned.

Rate limits are per tenant: reads, writes, creates, prepare, submit, verify,
webhook and public-checkout each have their own budget.

## 14. Security responsibilities

- **You hold the key.** The API key lives on your server. It must never be sent
  to a browser or bundled into a client.
- **You cannot authorize a payment.** The credential builds and verifies; only
  the customer's wallet signs and broadcasts.
- **Verify before you ship.** Confirm the recipient on each order matches your
  real receive address (or your xpub-derived destination).
- **Persist the webhook secret** in your own secret store — it is shown once.
- **Never test with real funds by accident.** There is no sandbox (§3); a real
  payment moves real funds.

## 15. Testing

There is **no sandbox or testnet**. Intent Pay is Monad mainnet only, so there is
no risk-free mode that still proves a real payment.

The safest available approach:

1. Test your integration **logic** locally against a local deployment (or use the
   self-service signup on any deployment — see §6). Create intents, checkouts,
   links and QR codes without any wallet.
2. Exercise the read and error paths: `GET /api/v1/capabilities`, create/validate,
   the idempotency replay, and the error codes in §13.
3. A `test` environment key is accepted outside production, but it does **not**
   change the chain — do not treat it as a sandbox.
4. A real end-to-end payment — a customer wallet signing on Monad mainnet — moves
   real funds and is the only way to prove settlement. Treat it as a production
   transaction.

Do not build a fake "test payment" that returns success; it would prove nothing
about the real path.

## 16. Production onboarding

1. Ask the deployment operator for a **production API key** (§6). Provide your
   business name and receive address.
2. Read `GET /api/v1/capabilities` for the real chain, assets and endpoints.
3. Optionally register a **watch-only payment xpub** so each order gets its own
   destination (§10).
4. Create your first real order, share the link, and confirm settlement with
   `verify` or a signed webhook.
5. Add a scheduled webhook drain (§12) so retries are not waiting on new traffic.

## Troubleshooting

- **`401 unauthorized`** — the key is missing, malformed, revoked or expired.
  The `Authorization` header must be `Bearer <key>`.
- **`403 forbidden` on `POST /api/v1/developers`** — this is the operator
  provisioning path and requires the admin token. For normal signup use the
  public `/api/v1/developers/register` → `/api/v1/developers/verify` flow (§6).
- **`403 forbidden` on a request with a valid-looking key** — a `test` key is
  being used in production without the override.
- **`409 conflict` creating a checkout** — the intent already has one. A second
  create returns the original link; use it.
- **`422 unsupported_token` / `route_unavailable`** — the requested asset has no
  price or no route on Monad. Fails honestly rather than fabricating a quote.
- **`503 storage_unavailable`** — the deployment has no durable store, so orders
  cannot be persisted. Not a client error.
- **A payment is `not_found` after submit** — the transaction is not yet on-chain
  (or the node is unreachable). It is retryable and never success; re-check with
  `verify`.

## Running the example

[`examples/merchant`](../examples/merchant) is a runnable merchant integration:
`node server.mjs` and open the printed URL. It imports only the published
contracts and holds the API key on its own server.

[`examples/merchant-onboarding`](../examples/merchant-onboarding) is a headless
walkthrough of the same lifecycle — capabilities → intent → checkout → payment
link → prepare → verify — that signs nothing and moves no funds, so it is safe to
run at any time:

```bash
INTENTPAY_API_KEY=ipk_… INTENTPAY_BASE_URL=http://localhost:3000 \
  node examples/merchant-onboarding/demo.mjs
```
