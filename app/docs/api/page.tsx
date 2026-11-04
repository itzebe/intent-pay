import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI, OL, Code, Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Developer API — Intent Pay",
  description:
    "Create payment intents, prepare Monad transactions for a wallet you control, and independently verify settlement. A secure, documented HTTP API.",
};

/**
 * The external developer API reference.
 *
 * Static and server-rendered so it is shareable, bookmarkable and crawlable. It
 * documents only what is implemented; the machine-readable companion is
 * `GET /api/v1/capabilities`.
 */
export default function DeveloperApiDocs() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Developer API"
        title="Payment infrastructure for your application"
        intro="Create a payment intent, hand your user a prepared transaction, and verify settlement on-chain — without custody, a paymaster, or a second payment stack."
      />

      <DocSection title="What this is">
        <P>
          The developer API turns Intent Pay into infrastructure other applications can build on.
          Your backend creates a payment intent, the user&apos;s own wallet signs a transaction the
          API prepared, and your backend asks the API to independently verify that the recipient was
          paid. The API never holds a key, never signs, and never broadcasts — it prepares and it
          verifies.
        </P>
        <UL>
          <LI><strong>Non-custodial.</strong> No private key, seed phrase or signature ever reaches the API.</LI>
          <LI><strong>Monad Mainnet only.</strong> Chain ID <Code>143</Code>. There is no testnet and no fallback chain.</LI>
          <LI><strong>Honest settlement.</strong> A <Code>success</Code> receipt is not a payment. <Code>/verify</Code> reads the authoritative receipt and proves the transfer.</LI>
          <LI><strong>No gas abstraction.</strong> The user&apos;s wallet pays the network fee in MON. There is no paymaster or bundler.</LI>
        </UL>
      </DocSection>

      <DocSection title="Base URL and versioning">
        <P>
          All endpoints live under <Code>/api/v1</Code>. The version is in the path, so a future
          change ships as <Code>/api/v2</Code> rather than breaking you in place. The current
          capabilities — chain, assets, endpoints, states, webhook events — are at{" "}
          <Code>GET /api/v1/capabilities</Code>, which requires no credential.
        </P>
      </DocSection>

      <DocSection title="Authentication">
        <P>Authenticate every request with a bearer API key:</P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">{`Authorization: Bearer ipk_live_<prefix>.<secret>`}</pre>
        </div>
        <P>
          A key is shown <strong>once</strong>, at creation. Only a salted hash is stored, so a lost
          key is rotated, never recovered. Keys are scoped to a single developer account (a tenant):
          it owns its keys, intents and webhooks, and no tenant can read or mutate another&apos;s.
        </P>
        <Callout tone="warn" title="Test vs live keys">
          A <Code>ipk_test_*</Code> key is refused in production unless the deployment explicitly
          allows test keys. Use a test key for development, a live key for mainnet.
        </Callout>
      </DocSection>

      <DocSection title="Quick start">
        <OL>
          <LI>Create a developer account and its first key (see &ldquo;Accounts and keys&rdquo;).</LI>
          <LI><Code>POST /api/v1/intents</Code> with the recipient, receive asset and amount.</LI>
          <LI><Code>POST /api/v1/intents/&#123;id&#125;/validate</Code> to check recipient, asset and route.</LI>
          <LI><Code>POST /api/v1/intents/&#123;id&#125;/prepare</Code> with the user&apos;s wallet address; you receive the transaction calls.</LI>
          <LI>Have the wallet sign and broadcast each call, in order.</LI>
          <LI><Code>POST /api/v1/intents/&#123;id&#125;/authorize</Code> before signing, then <Code>/submit</Code> with the hash.</LI>
          <LI><Code>POST /api/v1/intents/&#123;id&#125;/verify</Code> to prove settlement on-chain.</LI>
        </OL>
        <Callout tone="info" title="Authorize before you sign">
          <Code>/authorize</Code> freezes the recipient, asset and amount. After it, every
          prepare/submit/verify is checked against those frozen parameters byte-for-byte, so a
          recipient or amount can never be swapped after your user has seen it.
        </Callout>
      </DocSection>

      <DocSection title="Accounts and keys">
        <UL>
          <LI><Code>POST /api/v1/developers</Code> — create an account and its first key. In production this requires the admin token; outside production it is open. Returns the key <strong>once</strong>.</LI>
          <LI><Code>GET /api/v1/developers</Code> — your account and keys (prefix, environment, status — never a secret).</LI>
          <LI><Code>POST /api/v1/developers/keys</Code> — <Code>create</Code>, <Code>rotate</Code> or <Code>revoke</Code> a key. Rotation revokes the old key immediately.</LI>
        </UL>
      </DocSection>

      <DocSection title="Create an intent">
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">{`curl -X POST https://intent-pay-roan.vercel.app/api/v1/intents \\
  -H "Authorization: Bearer $INTENT_PAY_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042" \\
  -d '{
    "recipient": "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    "receiveToken": "USDC",
    "amount": "5.00",
    "amountMode": "recipient_receives",
    "reference": "order-1042"
  }'`}</pre>
        </div>
        <UL>
          <LI><Code>recipient</Code> — the Monad address that must be paid.</LI>
          <LI><Code>receiveToken</Code> — ticker or contract address. Resolved server-side; the canonical address is recorded.</LI>
          <LI><Code>amount</Code> — decimal string. With <Code>recipient_receives</Code> it is what the recipient gets; with <Code>i_spend</Code> it is what the sender spends.</LI>
          <LI><Code>amountMode</Code> — <Code>recipient_receives</Code> or <Code>i_spend</Code>.</LI>
          <LI><Code>payToken</Code> — optional. Pin the asset the sender spends; omit it and the wallet&apos;s holdings decide.</LI>
          <LI><Code>chainId</Code> — optional; only <Code>143</Code> is accepted.</LI>
          <LI><Code>reference</Code> — your own correlation id, echoed back and in webhooks.</LI>
        </UL>
        <Callout tone="info" title="Idempotency">
          Send an <Code>Idempotency-Key</Code> header (or the <Code>idempotencyKey</Code> body field).
          A retried create returns the original intent; reusing the key with different parameters is
          a <Code>409 idempotency_conflict</Code>, never a silent overwrite.
        </Callout>
      </DocSection>

      <DocSection title="Validate, prepare and authorize">
        <UL>
          <LI><Code>POST /intents/&#123;id&#125;/validate</Code> — checks the recipient, asset existence, amount and a live route. A failure records <Code>rejected</Code> with the specific reasons.</LI>
          <LI><Code>POST /intents/&#123;id&#125;/prepare</Code> — body <Code>&#123; sender, payToken? &#125;</Code>. Returns <Code>calls</Code> (<Code>to</Code>, <Code>data</Code>, <Code>value</Code>), the human <Code>steps</Code>, the <Code>minimumReceived</Code> guarantee, and a <Code>fingerprint</Code>. It never signs or sends.</LI>
          <LI><Code>POST /intents/&#123;id&#125;/authorize</Code> — freezes the parameters. Required before <Code>/submit</Code>.</LI>
        </UL>
        <Callout tone="warn" title="A prepared transaction is not a payment">
          <Code>/prepare</Code> only builds calldata. Your user&apos;s wallet must sign and broadcast
          it. The API cannot move funds on its own.
        </Callout>
      </DocSection>

      <DocSection title="Submit and verify settlement">
        <UL>
          <LI><Code>POST /intents/&#123;id&#125;/submit</Code> — body <Code>&#123; txHash &#125;</Code> or <Code>&#123; txHashes &#125;</Code>. Records the broadcast hash(es). Requires a prior authorize. A duplicate submit is refused.</LI>
          <LI><Code>POST /intents/&#123;id&#125;/verify</Code> — reads the authoritative Monad receipt and proves the recipient received the asset. Body <Code>&#123; txHash? &#125;</Code> defaults to the submitted hash.</LI>
        </UL>
        <P>The verify verdict is specific:</P>
        <UL>
          <LI><Code>verified</Code> — the recipient received at least the authorized minimum. The intent becomes <Code>verified</Code>.</LI>
          <LI><Code>reverted</Code> — the transaction failed on-chain. The intent becomes <Code>failed</Code>.</LI>
          <LI><Code>short</Code> — the recipient received less than intended. The intent becomes <Code>failed</Code>.</LI>
          <LI><Code>pending</Code> / <Code>not_found</Code> / <Code>unavailable</Code> — nothing is confirmed; the intent stays <Code>submitted</Code> and the response is <Code>retryable</Code>.</LI>
        </UL>
      </DocSection>

      <DocSection title="Webhooks">
        <P>
          Register a destination to be notified as an intent&apos;s state changes. Deliveries are
          signed and retried with backoff.
        </P>
        <UL>
          <LI><Code>POST /api/v1/webhooks</Code> — body <Code>&#123; url, events, description? &#125;</Code>. HTTPS only. The signing secret is returned once.</LI>
          <LI><Code>GET /api/v1/webhooks</Code> — list your destinations (never a secret).</LI>
          <LI><Code>DELETE /api/v1/webhooks/&#123;id&#125;</Code> — delete a destination.</LI>
          <LI><Code>GET /api/v1/webhooks/&#123;id&#125;/deliveries</Code> — delivery history (status, attempts, last status code).</LI>
        </UL>
        <P>Events: <Code>intent.created</Code>, <Code>intent.validated</Code>, <Code>transaction.prepared</Code>, <Code>transaction.submitted</Code>, <Code>transaction.confirmed</Code>, <Code>payment.verified</Code>, <Code>payment.failed</Code>, <Code>payment.rejected</Code>, <Code>intent.expired</Code>. Use <Code>[&quot;*&quot;]</Code> to receive all.</P>
        <P>Each delivery carries a signature header:</P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">{`X-IntentPay-Signature: t=<unix-seconds>,v1=<hex HMAC-SHA256>`}</pre>
        </div>
        <P>
          The signed message is <Code>{`\${t}.\${rawBody}`}</Code>, HMAC-SHA256 with your webhook&apos;s
          secret. Verify the HMAC <strong>and</strong> reject a <Code>t</Code> outside a five-minute
          tolerance — that is what stops a captured payload being replayed. The payload&apos;s{" "}
          <Code>id</Code> is stable across retries, so use it to drop a duplicate.
        </P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">{`// Verify a webhook (Node)
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (Math.abs(Date.now() / 1000 - t) > 300) return false; // stale -> replay
  const expected = createHmac("sha256", secret).update(t + "." + rawBody).digest();
  const got = Buffer.from(parts.v1, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}`}</pre>
        </div>
      </DocSection>

      <DocSection title="Errors">
        <P>
          Every error is a stable code and a short, client-safe message — never a raw provider
          string or a stack trace. The body is{" "}
          <Code>{`{ ok: false, error: { code, message, detail?, requestId? } }`}</Code>.
        </P>
        <UL>
          <LI><Code>400 invalid_request</Code> — a malformed body or field.</LI>
          <LI><Code>401 unauthorized</Code> / <Code>403 forbidden</Code> — a missing, wrong, revoked, expired or wrong-environment key.</LI>
          <LI><Code>404 not_found</Code> — no such intent, webhook or key (also used for another tenant&apos;s resource).</LI>
          <LI><Code>409 conflict</Code> / <Code>idempotency_conflict</Code> / <Code>invalid_state</Code> / <Code>already_submitted</Code> — a state or idempotency clash.</LI>
          <LI><Code>410 expired</Code> — the intent aged out before submission.</LI>
          <LI><Code>422 invalid_chain</Code> / <Code>invalid_recipient</Code> / <Code>invalid_amount</Code> / <Code>unsupported_token</Code> / <Code>route_unavailable</Code> — a payment cannot be built as requested.</LI>
          <LI><Code>429 rate_limited</Code> — the per-tenant limit was reached.</LI>
          <LI><Code>502 provider_error</Code> — an upstream provider failed.</LI>
          <LI><Code>503 storage_unavailable</Code> — durable storage is required but unavailable.</LI>
        </UL>
      </DocSection>

      <DocSection title="Rate limits">
        <P>
          Limits are per developer account, not per IP, so one tenant cannot exhaust another&apos;s
          budget and a shared NAT is not penalised. Reads allow 300 requests per minute; most writes
          60–120. A <Code>429</Code> means slow down and retry.
        </P>
      </DocSection>

      <DocSection title="Durability and honesty">
        <P>
          Intents, keys and webhooks need durable storage. If the deployment has no durable store,
          the API refuses with <Code>503 storage_unavailable</Code> rather than returning data that
          would vanish on the next cold start. <Code>GET /api/v1/capabilities</Code> reports the real
          storage kind and durability. Payment execution never depends on the store.
        </P>
      </DocSection>
    </DocsShell>
  );
}
