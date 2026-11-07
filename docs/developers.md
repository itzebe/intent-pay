# Developers

This guide is the repository-level developer onboarding. The in-app reference at
`/docs/api` documents every endpoint in detail; the SDK reference lives at
[`packages/sdk/README.md`](../packages/sdk/README.md).

## Onboarding

The fastest path is the in-app quickstart at
[`/docs/quickstart`](https://intent-pay-roan.vercel.app/docs/quickstart): it takes
you from a key to a verified settlement with the real request and response shapes.

1. Read [`vision.md`](./vision.md) and [`architecture.md`](./architecture.md).
2. Skim [`../AGENTS.md`](../AGENTS.md) — it lists the invariants that must not
   regress (the submission is never retried; a broadcast is not a success; the
   requested output asset is authoritative).
3. Run the app locally (below) and create a developer key. Signup is
   **self-service** on every deployment: `POST /api/v1/developers/register` emails
   a verification link, and `POST /api/v1/developers/verify` exchanges the token
   for your first key. An operator can also provision a key directly with
   `POST /api/v1/developers`, which requires the `INTENT_PAY_ADMIN_TOKEN`.
4. Exercise routing without a wallet via `POST /api/quote`.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # vitest (unit + component tests)
npm run build    # production build + typecheck
npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # strict typecheck
```

The SDK is a workspace package:

```bash
cd packages/sdk
npm run typecheck
npm test
npm run build
```

> `next dev` and `next build` share `.next/`. Running a build while the dev server
> is live can break its module cache; restart the dev server (or remove `.next`)
> afterwards.

## Environment

Everything is optional for a local demo; live routing and pricing need a real RPC.

```
MONAD_RPC_URL=https://rpc.monad.xyz
NEXT_PUBLIC_MONAD_RPC_URL=            # browser RPC (falls back to a public endpoint)
NEXT_PUBLIC_ALCHEMY_API_KEY=          # RPC transport + market prices
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID= # free from https://dashboard.reown.com
ZERION_API_KEY=                       # wallet asset discovery / USD valuation
INTENT_LLM_API_KEY=                   # optional, gap-filling only
INTENT_LLM_BASE_URL=https://api.openai.com/v1
INTENT_LLM_MODEL=gpt-4o-mini
```

No key is required to run the deterministic intent parser, the composer, or the
demo routing provider.

## API usage

The versioned API is the external contract.

```
POST /api/v1/intents                 create a payment intent
GET  /api/v1/intents/{id}            retrieve an intent and its lifecycle
POST /api/v1/intents/{id}/validate   recipient, asset, route, liquidity
POST /api/v1/intents/{id}/prepare    build the wallet calls (nothing is sent)
POST /api/v1/intents/{id}/authorize  freeze the parameters before signing
POST /api/v1/intents/{id}/submit     record the broadcast transaction hash(es)
POST /api/v1/intents/{id}/verify     verify settlement on-chain
POST /api/v1/checkouts               create a merchant checkout
```

`GET /api/v1/capabilities` is the machine-readable statement of the real chain,
endpoints, assets, intent states and webhook events — only what is implemented.

### Quickest way to exercise routing (no wallet)

```bash
curl -s -X POST http://localhost:3000/api/quote \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4","receiveToken":"USDC","receiveAmount":"5","amountMode":"recipient_receives","payToken":"USDT","mode":"live","network":"mainnet"}'
```

## SDK setup

The SDK lives in this repository at [`packages/sdk`](../packages/sdk) and is **not
yet published to npm**, so `npm install @intentpay/sdk` does not work today. Build
it and install the tarball:

```bash
cd packages/sdk
npm install
npm run build
npm pack                       # → intentpay-sdk-0.1.0.tgz

# in your own project:
npm install /path/to/intent-pay/packages/sdk/intentpay-sdk-0.1.0.tgz
```

The import specifiers are stable regardless of how it is installed. When the
package is published, `npm install @intentpay/sdk` replaces the build step.

```ts
import { IntentPay } from "@intentpay/sdk";

const pay = new IntentPay({ apiKey: process.env.INTENTPAY_API_KEY! });

const { intent } = await pay.createIntent({
  recipient: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  receiveToken: "USDC",
  amount: "5",                 // USD: the recipient receives $5 worth of USDC
  idempotencyKey: "order-1234",
});

await pay.validateIntent(intent.id);
const prepared = await pay.prepareTransaction(intent.id, { sender: userAddress });
// prepared.calls → [{ to, data, value }, …]
// prepared.quote.minimumReceived → the on-chain guaranteed floor
```

The browser wallet layer is a separate entry point so the server-safe client never
pulls in DOM code:

```ts
import { Wallet, discoverWallets } from "@intentpay/sdk/wallet";

const wallet = await Wallet.connect({ walletId: "io.metamask" });
await wallet.ensureMonadChain();
const { txHashes } = await wallet.sendCalls(prepared.calls);
```

## Integration examples

- [In-app quickstart](https://intent-pay-roan.vercel.app/docs/quickstart) — the
  same lifecycle, with the real request/response shapes.
- [`examples/quickstart`](../examples/quickstart) — a minimal server that creates
  an intent and serves a payment page.
- [`examples/merchant`](../examples/merchant) — a merchant integration.
- [`examples/status-and-verify`](../examples/status-and-verify) — a headless
  status check and settlement verification (no browser, no wallet).

The examples are runnable with `node server.mjs` (or `node check.mjs`); see each
example's README.

## Testing

- **Unit and component tests** — `npm test` (vitest). Pure logic is tested
  directly; wallet discovery is tested against a fake `window`.
- **SDK tests** — `cd packages/sdk && npm test`.
- **Live routing tests** — gated on `MONAD_LIVE_TESTS=1`; these call the real
  Monad RPC and are skipped otherwise.

When a test touches tokens or a cached provider, use unique addresses/keys per
test — the token registry and `TtlCache` are module-level and will otherwise leak
state between cases.

## Error handling

Errors are typed and user-safe.

- `ApiError` — an HTTP response with a status and a stable code.
- `TransportError` — the request never completed.
- `isRetryable(err)` — a safe retry (a read) versus a state change.
- `isAmbiguousSubmission(err)` — a submission whose outcome is unknown; this must
  **not** be retried blindly.

A raw upstream error is never surfaced to a user; the message is sanitised on the
server and classified on the client.
