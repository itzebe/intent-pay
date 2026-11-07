import type { Metadata } from "next";
import Link from "next/link";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI, Code, Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Quickstart — Intent Pay",
  description:
    "Integrate Intent Pay in ten minutes: install the SDK, authenticate, create an intent, prepare the wallet calls, record the broadcast and verify settlement on Monad.",
};

/**
 * `/docs/quickstart` — the developer onboarding quickstart.
 *
 * Every command, field and response below was taken from a real local run of the
 * shipped API and SDK (see the repository's `examples/` and `tests/`), not from a
 * design sketch. Where a capability does not exist yet — a published npm package —
 * it says so and gives the supported alternative.
 */
export default function Quickstart() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Quickstart"
        title="Your first Intent Pay integration"
        intro="From nothing to a verified on-chain payment: install the SDK, authenticate, create an intent, prepare the wallet calls, record the broadcast, and verify settlement. Every step here runs against the real API."
      />

      <DocSection title="What you are building">
        <P>
          Intent Pay splits a payment in two. <strong>Your server</strong> holds an API key and does
          every credential-bearing call — create, validate, prepare, authorize, submit, verify.{" "}
          <strong>Your user&apos;s wallet</strong> holds the key to the funds and signs the
          transaction locally. The two never meet: the API never sees a private key, and the wallet
          never sees your API key.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`browser (wallet)                 your server (API key)              Intent Pay
────────────────                 ─────────────────────              ──────────
Wallet.connect()      ────────▶  createIntent()            ────────▶ /api/v1/intents
                                 validateIntent()          ────────▶ …/validate
prepareTransaction()  ◀────────  prepareTransaction()      ────────▶ …/prepare
wallet.sendCalls()    ────────▶  submitTransaction()       ────────▶ …/submit
                                 verifySettlement()        ────────▶ …/verify`}
          </pre>
        </div>
      </DocSection>

      <DocSection title="1. Prerequisites">
        <UL>
          <LI>
            <strong>Node.js 20.19+</strong> for the SDK (the app itself requires Node 24.22+).
          </LI>
          <LI>
            <strong>A developer account and API key.</strong> Signup is <strong>self-service</strong>:
            create an account with your email at the{" "}
            <Link href="/developer">developer portal</Link>, open the verification link, and your
            first key is issued once. The operator can also provision a key directly with{" "}
            <Code>INTENT_PAY_ADMIN_TOKEN</Code> (step 3) — the admin token is never needed for normal
            signup.
          </LI>
          <LI>
            <strong>Monad Mainnet access.</strong> Intent Pay is Monad-only, chain id{" "}
            <Code>143</Code>. There is no testnet.
          </LI>
          <LI>
            <strong>Durable storage on your deployment.</strong> Intents, keys and webhooks require
            it; without it the API refuses with <Code>503 storage_unavailable</Code> rather than
            returning data that would vanish. The hosted deployment uses managed Postgres.
          </LI>
        </UL>
      </DocSection>

      <DocSection title="2. Install the SDK">
        <P>
          The SDK lives in this repository and is <strong>not yet published to npm</strong>, so it is
          built from source and installed as a tarball. The import specifiers are stable either way.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`# build the SDK from the repository, then install the tarball
git clone https://github.com/itzebe/intent-pay
cd intent-pay/packages/sdk && npm install && npm run build && npm pack
# → intentpay-sdk-0.1.0.tgz

# in your own project:
npm install /path/to/intent-pay/packages/sdk/intentpay-sdk-0.1.0.tgz

# optional: mobile / QR wallets (peer dependency)
npm install @walletconnect/ethereum-provider`}
          </pre>
        </div>
        <Callout tone="info" title="Prefer to skip the SDK?">
          The HTTP API is the contract. Everything below has an equivalent <Code>curl</Code> call, so
          you can integrate without the SDK and add it later.
        </Callout>
      </DocSection>

      <DocSection title="3. Authentication">
        <P>
          Signup is self-service. Register an email, open the verification link, and your first key is
          returned <strong>once</strong>. No administrator token is involved.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`# 1. start signup (a verification email is sent)
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"my-app","email":"you@example.com"}'

# 2. exchange the token from the email for your first key
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers/verify \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"ipv_…"}'`}
          </pre>
        </div>
        <P>
          An operator can also provision an account directly, which requires the admin token:
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`# operator provisioning (support / bulk onboarding)
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers \\
  -H "Authorization: Bearer $INTENT_PAY_ADMIN_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"my-app","environment":"live"}'`}
          </pre>
        </div>
        <P>The response carries the key <strong>once</strong>:</P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`{
  "ok": true,
  "developer": { "id": "dev_…", "name": "my-app", "status": "active" },
  "apiKey": "ipk_test_<prefix>.<secret>",
  "keyId": "key_…",
  "environment": "test",
  "warning": "Store this key securely. It is shown once and cannot be retrieved again."
}`}
          </pre>
        </div>
        <P>
          Send the key as a bearer token on every authenticated request. Only a salted hash is
          stored, so a lost key is <em>rotated</em>, never recovered.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`Authorization: Bearer ipk_live_<prefix>.<secret>`}
          </pre>
        </div>
        <Callout tone="warn" title="Test vs live keys">
          An <Code>ipk_test_*</Code> key is refused in production (a local deployment accepts it when{" "}
          <Code>INTENT_PAY_ALLOW_TEST_KEYS=1</Code> is set). Use a test key against a local or preview
          deployment, a live key against production.
        </Callout>
      </DocSection>

      <DocSection title="4. Your first integration">
        <P>
          An <strong>intent</strong> is a statement of the outcome: <em>this recipient receives this
          token, worth this amount</em>. Creating one sends nothing — it is a request.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`import { IntentPay } from "@intentpay/sdk";

const pay = new IntentPay({
  apiKey: process.env.INTENTPAY_API_KEY!,          // server-side only
  baseUrl: "https://intent-pay-roan.vercel.app",   // or your own deployment
});

const { intent, created } = await pay.createIntent({
  recipient: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  receiveToken: "USDC",
  amount: "5",                  // USD: the recipient receives $5 worth of USDC
  amountMode: "recipient_receives",
  reference: "order-1042",      // your own id, echoed back
  idempotencyKey: "order-1042", // a retry returns the same intent
});

console.log(intent.id, intent.state, created); // int_…  created  true`}
          </pre>
        </div>
        <P>
          <Code>amount</Code> is a <strong>USD value</strong>, not token units.{" "}
          <Code>amountMode</Code> chooses where it is measured: <Code>recipient_receives</Code>{" "}
          (default — the recipient gets exactly that value) or <Code>i_spend</Code>.
        </P>
        <P>Then validate, and prepare the calls the wallet must send:</P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`const validation = await pay.validateIntent(intent.id);
// { valid: true, validation: { recipient, receiveToken, amount,
//   route: { available: true, path: ["USDC","USDC"] }, receiveAmountToken: "5" } }

const prepared = await pay.prepareTransaction(intent.id, { sender: userAddress });
// prepared.calls      → [{ to, data, value }, …]   (approve → swap → unwrap → deliver)
// prepared.steps      → ["Send USDC to recipient", …]
// prepared.quote      → { payAmount, receiveAmount, minimumReceived, slippageBps, networkCostUsd }
// prepared.fingerprint → the exact build this quote belongs to`}
          </pre>
        </div>
        <Callout tone="warn" title="A prepared transaction is not a payment">
          <Code>prepare</Code> builds calldata; it does not sign or broadcast. Nothing is paid until
          the wallet sends the calls and <Code>verify</Code> reads the receipt.
        </Callout>
      </DocSection>

      <DocSection title="5. Hand the calls to the wallet">
        <P>
          The browser half uses a separate entry point, <Code>@intentpay/sdk/wallet</Code>, so the
          API key can never reach the page. <Code>sendCalls</Code> enforces Monad, sends the calls in
          order and waits for each receipt.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`import { Wallet, discoverWallets } from "@intentpay/sdk/wallet";

const wallets = await discoverWallets();       // EIP-6963 + legacy window.ethereum
const wallet  = await Wallet.connect({ walletId: "io.metamask" });
await wallet.ensureMonadChain();               // switch to 143, adding it if unknown

const { txHashes } = await wallet.sendCalls(prepared.calls);
// send the hashes back to your server, which records and verifies them:
await fetch("/api/pay/submit", {
  method: "POST",
  body: JSON.stringify({ intentId: intent.id, txHashes }),
});`}
          </pre>
        </div>
      </DocSection>

      <DocSection title="6. Record the broadcast and verify settlement">
        <P>
          Authorize freezes the recipient, asset and amount <em>before</em> signing, so nothing can
          be swapped afterwards. Submit records the hash the wallet produced. Verify reads the Monad
          receipt itself — the only thing that means &ldquo;paid&rdquo;.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`await pay.authorizeIntent(intent.id);                      // freeze the parameters
await pay.submitTransaction(intent.id, { txHashes });      // record the hash(es)

const { verdict } = await pay.verifySettlement(intent.id);
// "verified" | "pending" | "short" | "not_found" | "unavailable"`}
          </pre>
        </div>
        <Callout tone="ok" title="Only 'verified' means paid">
          A <Code>success</Code> receipt is not a payment. A hash that is not on-chain comes back{" "}
          <Code>not_found</Code>; a short delivery comes back <Code>short</Code>. Neither is ever
          reported as success.
        </Callout>
      </DocSection>

      <DocSection title="7. Payment status and outcomes">
        <P>
          For a UI, read the lifecycle rather than polling the chain.{" "}
          <Code>getPaymentStatus</Code> is derived from the intent&apos;s real state.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`const status = await pay.getPaymentStatus(intent.id);
// { id, state, settled, failed, intent, … }

// States, in order:
// created → validating → validated → prepared → awaiting_authorization
//         → submitted → confirmed → verified      (terminal: verified|rejected|expired|failed)
// settled is true only at "verified".`}
          </pre>
        </div>
        <P>
          A merchant order wraps the same intent in a checkout with a shareable link; the customer
          phase is finer-grained so a checkout never says &ldquo;paid&rdquo; too early.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`const { checkout, token } = await pay.createCheckout({
  intentId: intent.id,
  orderReference: "ORDER-1042",
  idempotencyKey: "ORDER-1042",
});
const link = \`https://intent-pay-roan.vercel.app/checkout/\${token}\`; // safe to share

const { verdict, retryable } = await pay.verifyCheckout(checkout.id);`}
          </pre>
        </div>
      </DocSection>

      <DocSection title="8. Error handling">
        <P>
          Every failure is a stable <Code>code</Code> and a short, client-safe message — never a raw
          provider string. Branch on the code, never on message text.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`import { isRetryable, isAmbiguousSubmission } from "@intentpay/sdk";

try {
  await pay.submitTransaction(intent.id, { txHashes });
} catch (err) {
  if (isAmbiguousSubmission(err)) {
    // The request may have reached the server. Reconcile; never retry blindly.
    const status = await pay.getPaymentStatus(intent.id);
  } else if (isRetryable(err)) {
    // safe to try again (with backoff)
  } else {
    // a validation or state error — fix the request, do not retry
  }
}`}
          </pre>
        </div>
        <UL>
          <LI><Code>ApiError</Code> — the server answered with an error envelope (<Code>code</Code>, <Code>status</Code>, <Code>requestId</Code>).</LI>
          <LI><Code>TransportError</Code> — the request never completed (timeout, connection failure).</LI>
          <LI><Code>ConfigurationError</Code> — bad client config, caught before any request.</LI>
          <LI><Code>WalletError</Code> — a wallet-layer failure (<Code>wallet_rejected</Code>, <Code>wallet_wrong_chain</Code>, <Code>wallet_unknown_outcome</Code>).</LI>
        </UL>
        <P>
          The server also returns a <Code>requestId</Code> on every error; quote it in support
          requests. Common codes: <Code>unauthorized</Code>/<Code>forbidden</Code> (key),
          <Code>invalid_state</Code> (authorize before submit), <Code>route_unavailable</Code>/
          <Code>unsupported_token</Code> (no path for the requested asset),{" "}
          <Code>rate_limited</Code> (slow down), <Code>storage_unavailable</Code> (deployment has no
          durable store).
        </P>
      </DocSection>

      <DocSection title="9. Rate limits">
        <P>
          Limits are per developer account, not per IP. Reads allow 300 requests per minute; create,
          prepare, submit and verify allow 60; webhook registration allows 30. A <Code>429</Code>{" "}
          carries a <Code>Retry-After</Code>; the SDK retries it with backoff automatically.
        </P>
      </DocSection>

      <DocSection title="10. Troubleshooting">
        <UL>
          <LI>
            <strong>&ldquo;Operator provisioning requires the admin token&rdquo;</strong> — you are
            calling <Code>POST /api/v1/developers</Code> (the operator path). For normal signup, use{" "}
            <Code>/api/v1/developers/register</Code> and <Code>/api/v1/developers/verify</Code>, which
            need no token.
          </LI>
          <LI>
            <strong><Code>email_unavailable</Code></strong> — self-service signup needs an email
            provider configured on the deployment: either SMTP (<Code>EMAIL_PROVIDER=smtp</Code>,{" "}
            <Code>EMAIL_FROM</Code>, <Code>SMTP_HOST</Code>, <Code>SMTP_PORT</Code>,{" "}
            <Code>SMTP_USER</Code>, <Code>SMTP_PASS</Code>) or Resend (<Code>RESEND_API_KEY</Code> +{" "}
            <Code>EMAIL_FROM</Code>). The operator provisions keys directly meanwhile.
          </LI>
          <LI>
            <strong>&ldquo;Test API keys are not accepted in production&rdquo;</strong> — use a live
            key against production, or a test key against a local deployment.
          </LI>
          <LI>
            <strong><Code>503 storage_unavailable</Code></strong> — the deployment has no durable
            store. Set <Code>DATABASE_URL</Code> (Postgres) or <Code>INTENT_PAY_DB_PATH</Code>.
          </LI>
          <LI>
            <strong><Code>invalid_state</Code> on submit</strong> — call <Code>authorize</Code>{" "}
            before <Code>submit</Code>. Authorize is what freezes the parameters before signing.
          </LI>
          <LI>
            <strong>&ldquo;No transaction hash to verify&rdquo;</strong> — <Code>verify</Code> needs a
            hash. Submit the wallet&apos;s hash first, or pass <Code>txHash</Code>.
          </LI>
          <LI>
            <strong>The key is rejected as malformed by the SDK</strong> — the shape is{" "}
            <Code>ipk_live_&lt;prefix&gt;.&lt;secret&gt;</Code>. Copy the whole value returned at
            creation.
          </LI>
        </UL>
      </DocSection>

      <DocSection title="Runnable examples">
        <UL>
          <LI>
            <Link href="/docs/api" className="text-mono-soft hover:underline">
              API reference
            </Link>{" "}
            — every endpoint, request and response.
          </LI>
          <LI>
            <Code>examples/quickstart</Code> — a minimal server that creates an intent and serves a
            payment page (browser wallet + server key).
          </LI>
          <LI>
            <Code>examples/merchant</Code> — a complete merchant integration: checkout, payment
            links, webhook verification and settlement evidence.
          </LI>
          <LI>
            <Code>examples/status-and-verify</Code> — a headless server script that retrieves status
            and verifies settlement, with no browser or wallet.
          </LI>
        </UL>
      </DocSection>
    </DocsShell>
  );
}
