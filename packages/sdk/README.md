# `@intentpay/sdk`

TypeScript SDK for **Intent Pay** — intent-based payments on **Monad Mainnet** (chain `143`).

An intent states what the *recipient* should receive. Intent Pay works out which asset the
*sender* spends, the amount, the route and the calldata. This SDK lets a server create and
track those intents, and lets a browser hand the prepared calls to the user's own wallet.

Three entry points, so nothing you do not use is pulled into your bundle:

| Import | Runs in | Contains |
| --- | --- | --- |
| `@intentpay/sdk` | server | the API client (holds your API key) |
| `@intentpay/sdk/wallet` | browser | EIP-1193 + WalletConnect wallet layer |
| `@intentpay/sdk/webhooks` | anywhere | webhook signature verification |

## Install

```bash
npm install @intentpay/sdk
```

For WalletConnect (mobile / QR wallets):

```bash
npm install @walletconnect/ethereum-provider
```

## The one rule: the API key stays on your server

The SDK **refuses to construct a keyed client in a browser**:

```ts
// In a browser, without the override, this throws `client_credential_in_browser`:
const client = new IntentPay({ apiKey: "ipk_live_…" });
```

The wallet signs locally and the API key authorizes API calls; they are different things and
must not meet. The correct shape is a server that holds the key and a browser that holds the
wallet:

```
browser (wallet)                     your server (API key)            Intent Pay
────────────────                     ─────────────────────            ──────────
Wallet.connect()          ────────▶  createIntent()          ────────▶  /api/v1/intents
                                     validateIntent()
prepareTransaction()      ◀────────  prepareTransaction()
wallet.sendCalls(calls)   ────────▶  submitTransaction()     ────────▶  /api/v1/…/submit
                                     verifySettlement()      ────────▶  /api/v1/…/verify
```

`dangerouslyAllowBrowser: true` exists for local experiments only.

## Server: create, validate, prepare, verify

```ts
import { IntentPay } from "@intentpay/sdk";

const pay = new IntentPay({ apiKey: process.env.INTENTPAY_API_KEY! });

// `amount` is a USD value: the recipient receives $5 worth of USDC.
const { intent } = await pay.createIntent({
  recipient: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  receiveToken: "USDC",
  amount: "5",
  idempotencyKey: "order-1234", // a retry returns the same intent
});

await pay.validateIntent(intent.id);          // recipient, asset, route, liquidity

// Build the calls your user's wallet must send. Nothing is signed or sent here.
const prepared = await pay.prepareTransaction(intent.id, { sender: userAddress });
// prepared.calls → [{ to, data, value }, …]   e.g. approve → swap → unwrap → deliver
// prepared.quote.minimumReceived            → the on-chain guaranteed floor
```

Then, after the wallet broadcasts:

```ts
await pay.authorizeIntent(intent.id);                       // freeze the parameters
await pay.submitTransaction(intent.id, { txHashes });       // record the hash(es)

// Independent, on-chain verification — the only thing that means "paid".
const { verdict } = await pay.verifySettlement(intent.id);
// verdict: "verified" | "pending" | "short" | "not_found" | "unavailable"
```

`verifySettlement` reads the Monad receipt itself. A hash that is not on-chain comes back
`not_found`; a short delivery comes back `short`. Neither is ever reported as success.

### Amounts are USD

`amount: "5"` means *the recipient receives $5 worth of `receiveToken`*, not 5 units of it.
`amountMode` chooses where the $5 is measured: `recipient_receives` (default) or `i_spend`.

## Browser: connect a wallet and pay

```ts
import { Wallet, discoverWallets } from "@intentpay/sdk/wallet";

const wallets = await discoverWallets();       // EIP-6963 + legacy window.ethereum
const wallet = await Wallet.connect({ walletId: "io.metamask" }); // or omit for the only one

console.log(wallet.address);                   // 0x…
await wallet.ensureMonadChain();               // switch to 143, adding it if unknown

wallet.onAccountsChanged((address) => { /* the user switched account */ });
wallet.onChainChanged((chainId) => { /* the user switched network */ });

// Sign + broadcast the calls your server prepared, in order.
const { txHashes } = await wallet.sendCalls(prepared.calls);
await fetch("/api/pay/submit", {
  method: "POST",
  body: JSON.stringify({ intentId: intent.id, txHashes }),
});
```

WalletConnect (mobile / QR) uses the same handle:

```ts
const wallet = await Wallet.connectWalletConnect({
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!,
});
```

> **WalletConnect needs a project id.** Register a (free) project at
> <https://dashboard.reown.com> and expose its id to the browser as a public
> variable (`NEXT_PUBLIC_…`). It is a public identifier, not a secret. Add Monad
> Mainnet (143) to the project's allowed chains. Without a project id,
> `connectWalletConnect` throws `wallet_not_found` and the injected path keeps
> working — nothing else depends on WalletConnect.

### What the wallet layer guarantees

- **Monad is enforced.** `sendCalls` calls `ensureMonadChain()` first, so a payment is never
  broadcast from another network. A refused switch throws `wallet_wrong_chain`.
- **A rejection is its own outcome.** Declining in the wallet throws `wallet_rejected`; it is
  never mistaken for a technical failure.
- **Keys never leave the wallet.** The SDK sends `eth_sendTransaction`; the wallet shows its own
  prompt and signs locally. The SDK never sees, asks for, or stores a key or seed phrase.

## Checkout (merchant orders)

A checkout turns an intent into a payable order with a shareable payment link. Create the
intent first, then wrap it — the checkout freezes the intent's parameters, so the amount,
asset and recipient can never change once a link exists.

```ts
const { intent } = await pay.createIntent({
  recipient: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  receiveToken: "USDC",
  amount: "25",
  amountMode: "recipient_receives",
  reference: "ORDER-1001",
});

const { checkout, token } = await pay.createCheckout({
  intentId: intent.id,
  orderReference: "ORDER-1001",
  idempotencyKey: "order-1001", // a retry returns the same link
});

// Share this with your customer. The page carries no credential.
const link = `https://intent-pay-roan.vercel.app/checkout/${token}`;
```

Your customer's own wallet signs and broadcasts; you only read the outcome:

```ts
await pay.getCheckout(checkout.id);              // the order + its bound intent
await pay.listCheckouts();                       // newest first

// For a custom front end, build the calls for the customer's address.
const prepared = await pay.prepareCheckout(checkout.id, { sender: customerAddress });
// The customer's wallet sends prepared.calls, then reports the hash back:
await pay.submitCheckout(checkout.id, { txHashes });

// Independent, on-chain verification — the only thing that completes the order.
const { verdict, retryable } = await pay.verifyCheckout(checkout.id);
// verdict: "verified" | "pending" | "not_found" | "unavailable" | "short" | "reverted" | "contradictory"

await pay.getCheckoutEvidence(checkout.id);      // settlement evidence, re-verified live
await pay.cancelCheckout(checkout.id);           // cancel an unpaid order
```

The hosted customer page at `/checkout/:token` is a thin client of the public
`/api/checkout/:token` routes, and the merchant console at `/merchant` is a thin client of
this same API. The merchant key can **build** and **verify**, but it can never authorize a
payment — only the customer's wallet can.

## Webhooks

Register a webhook (the signing secret is shown once):

```ts
const { webhook, secret } = await pay.createWebhook({
  url: "https://example.com/intentpay-webhook",
  events: ["payment.verified", "intent.failed"],
});
```

Verify every delivery against the **raw** body:

```ts
import { verifyWebhookSignature } from "@intentpay/sdk/webhooks";

const result = await verifyWebhookSignature({
  secret: process.env.INTENTPAY_WEBHOOK_SECRET!,
  signature: req.headers["x-intentpay-signature"],
  body: rawBody, // the exact bytes received — never a re-serialized object
});
if (!result.ok) return res.status(400).json({ reason: result.reason });
```

The signature is `t=<unix>,v1=<hex HMAC-SHA256>` over `` `${t}.${body}` ``. A timestamp outside
the tolerance is rejected, so a captured payload cannot be replayed.

## Errors

Every failure is a typed error. Catch on `code`, not on message text:

```ts
import { ApiError, TransportError, isRetryable, isAmbiguousSubmission } from "@intentpay/sdk";

try {
  await pay.submitTransaction(id, { txHash });
} catch (err) {
  if (isAmbiguousSubmission(err)) {
    // The request may have reached the server. Reconcile; do not blindly retry.
    const status = await pay.getPaymentStatus(id);
  } else if (isRetryable(err)) {
    // safe to try again
  }
}
```

| Class | Meaning |
| --- | --- |
| `ApiError` | the server answered with an error envelope (`code`, `status`, `requestId`) |
| `TransportError` | the request never completed (timeout, connection failure) |
| `ConfigurationError` | bad client configuration, caught before any request |
| `WalletError` | a wallet-layer failure (`walletCode`: `wallet_rejected`, `wallet_wrong_chain`, …) |

### Retries are safe by construction

The client retries a `429`, a `408` and any `5xx` with exponential backoff and jitter. A
**non-idempotent** call (`submitTransaction`) is retried only when the request provably never
reached the server — a submitting call is never repeated blindly, because the transaction may
already exist. A `createIntent` with an `idempotencyKey` is safe to retry.

## Capabilities

```ts
const caps = await pay.getCapabilities(); // no credential required
caps.network.chainId;                     // 143
caps.features.credentialCanSign;          // false — the credential can never sign
caps.features.keyCustody;                 // false — the server never holds a key
```

## Live tests

Unit tests need no network. The live suites run against a real deployment when you point them
at one:

```bash
INTENTPAY_BASE_URL=http://localhost:3000 \
INTENTPAY_API_KEY=ipk_live_… \
npx vitest run test/integration.live.test.ts test/walletFlow.live.test.ts
```

They create a real intent, quote a real Monad route, prepare real calldata, and drive a wallet
through `eth_sendTransaction`. They never sign or broadcast a real transaction.

## License

MIT
