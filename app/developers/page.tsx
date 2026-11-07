import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell, Section, FeatureGrid, NextStep } from "@/components/landing/MarketingShell";
import { Code } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Developers — Intent Pay",
  description:
    "Build payments on Monad with the Intent Pay v1 HTTP API and TypeScript SDK: create an intent, prepare the transaction calls, record the broadcast, and verify settlement on-chain.",
};

/**
 * `/developers` — the developer entry point.
 *
 * Every endpoint, method and field below is taken from the shipped API and SDK
 * (`app/api/v1/*`, `packages/sdk`). Nothing here is aspirational.
 */
export default function Developers() {
  return (
    <MarketingShell
      eyebrow="Developers"
      title="Programmatic payments on Monad"
      intro="A versioned HTTP API and a TypeScript SDK that take a payment intent from creation to independently verified settlement. Your server holds the API key; your user's wallet signs locally. The two never meet."
      actions={
        <>
          <Link href="/developer" className="btn-primary">
            Get an API key
          </Link>
          <Link href="/docs/api" className="btn-ghost">
            API reference
          </Link>
          <Link href="/docs/developers" className="btn-ghost">
            Integration guide
          </Link>
        </>
      }
    >
      <Section
        title="Get an API key"
        intro="Self-service: create an account with your email, verify it, and receive your first key."
      >
        <div className="space-y-3 text-sm leading-relaxed text-white/55">
          <p className="text-pretty">
            Open the{" "}
            <Link href="/developer" className="text-mono-soft hover:underline">
              developer portal
            </Link>
            , enter your email, and open the verification link we send. Your first API key is issued{" "}
            <strong className="text-white/80">once</strong>, only after the address is verified — so an address
            you do not control can never obtain a credential. Manage additional keys, rotation and revocation
            from the same portal.
          </p>
        </div>
        <div className="card-flat mt-4 overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`# 1. start signup — a verification email is sent
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers/register \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"my-app","email":"you@example.com"}'

# 2. open the link from the email, or exchange the token for your key
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/developers/verify \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"ipv_…"}'`}
          </pre>
        </div>
      </Section>

      <Section
        title="The payment lifecycle, as an API"
        intro="Five calls mirror the five stages. Nothing is signed or broadcast on the server."
      >
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`POST /api/v1/intents                    create the payment intent
POST /api/v1/intents/{id}/validate       recipient, asset, route, liquidity
POST /api/v1/intents/{id}/prepare        build the wallet calls (nothing is sent)
POST /api/v1/intents/{id}/authorize      freeze the parameters before signing
POST /api/v1/intents/{id}/submit         record the broadcast transaction hash(es)
POST /api/v1/intents/{id}/verify         verify settlement on-chain — the only "paid"`}
          </pre>
        </div>
      </Section>

      <Section title="Install the SDK">
        <p className="mb-3 text-sm leading-relaxed text-white/55">
          The SDK is developed in this repository and is not yet on npm, so it is
          built and installed from source. The import specifiers are stable either way.
        </p>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`# build the SDK from this repository, then install the tarball
cd packages/sdk && npm install && npm run build && npm pack
npm install /path/to/intent-pay/packages/sdk/intentpay-sdk-0.1.0.tgz

# optional: mobile / QR wallets (peer dependency)
npm install @walletconnect/ethereum-provider`}
          </pre>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-white/55">
          When the package is published, <Code>npm install @intentpay/sdk</Code> replaces the build step.
        </p>
      </Section>

      <Section
        title="Create, prepare, verify"
        intro="The recipient receives a USD amount of the token you name. Routing is resolved for you."
      >
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`import { IntentPay } from "@intentpay/sdk";

const pay = new IntentPay({ apiKey: process.env.INTENTPAY_API_KEY! });

// The recipient receives $5 worth of USDC.
const { intent } = await pay.createIntent({
  recipient: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  receiveToken: "USDC",
  amount: "5",
  idempotencyKey: "order-1234", // a retry returns the same intent
});

await pay.validateIntent(intent.id);

// Build the calls the user's wallet must send. Nothing is signed here.
const prepared = await pay.prepareTransaction(intent.id, { sender: userAddress });
// prepared.calls → [{ to, data, value }, …]  (approve → swap → unwrap → deliver)
// prepared.quote.minimumReceived → the on-chain guaranteed floor

// After the wallet broadcasts:
await pay.authorizeIntent(intent.id);
await pay.submitTransaction(intent.id, { txHashes });
const { verdict } = await pay.verifySettlement(intent.id);
// "verified" | "pending" | "short" | "not_found" | "unavailable"`}
          </pre>
        </div>
      </Section>

      <Section
        title="Browser wallet, server key"
        intro="The API key authorizes API calls; the wallet signs. The SDK refuses to construct a keyed client in a browser."
      >
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`import { Wallet, discoverWallets } from "@intentpay/sdk/wallet";

const wallets = await discoverWallets();          // EIP-6963 + legacy window.ethereum
const wallet  = await Wallet.connect({ walletId: "io.metamask" });
await wallet.ensureMonadChain();                  // switch to 143, adding it if unknown

const { txHashes } = await wallet.sendCalls(prepared.calls); // in order, each confirmed`}
          </pre>
        </div>
      </Section>

      <Section title="What the API covers">
        <FeatureGrid
          items={[
            { t: "Intents", d: "Create, validate, prepare, authorize, submit and verify a payment intent. Amounts are USD; amountMode picks where the value is measured." },
            { t: "Checkouts", d: "Wrap an intent in a merchant checkout: create, prepare for the customer, submit, verify, cancel, and read settlement evidence." },
            { t: "Webhooks", d: "Register endpoints and receive intent, transaction, payment and checkout events, with signature verification." },
            { t: "Capabilities", d: "GET /api/v1/capabilities advertises the real chain, endpoints, assets, intent states and webhook events — only what is implemented." },
          ]}
        />
      </Section>

      <Section title="Errors and safety">
        <div className="space-y-3 text-sm leading-relaxed text-white/55">
          <p className="text-pretty">
            Errors are typed. <Code>ApiError</Code> carries an HTTP status and a stable code;{" "}
            <Code>TransportError</Code> means the request never completed.{" "}
            <Code>isRetryable(err)</Code> distinguishes a safe retry from a state change, and{" "}
            <Code>isAmbiguousSubmission(err)</Code> flags a submission whose outcome is unknown — the
            case that must never be retried blindly.
          </p>
          <p className="text-pretty">
            Settlement is only &ldquo;paid&rdquo; when <Code>verifySettlement</Code> reads the Monad
            receipt itself. A hash that is not on-chain comes back <Code>not_found</Code>; a short
            delivery comes back <Code>short</Code>. Neither is ever reported as success.
          </p>
        </div>
      </Section>

      <Section title="Next">
        <div className="grid gap-3 sm:grid-cols-2">
          <NextStep href="/docs/quickstart" label="Quickstart" body="Authenticate, create an intent, prepare, submit and verify" />
          <NextStep href="/docs/api" label="API reference" body="Every endpoint, request and response" />
          <NextStep href="/docs/developers" label="Integration guide" body="Repository layout, commands and configuration" />
          <NextStep href="/docs/checkout" label="Merchant checkout" body="The two-step intent → checkout model" />
          <NextStep href="/docs/security" label="Security model" body="Signing guard, bounds and honest limits" />
        </div>
      </Section>
    </MarketingShell>
  );
}
