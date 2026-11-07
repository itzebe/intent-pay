import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell, Section, FeatureGrid, NextStep } from "@/components/landing/MarketingShell";
import { Code, Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Merchants — Intent Pay",
  description:
    "Accept crypto payments with a checkout link or QR. Your customer pays with their own wallet; you receive the exact asset you asked for, with settlement verified on-chain.",
};

/**
 * `/merchants` — the merchant entry point.
 *
 * It answers five questions in order (what it does, how a customer pays, how you
 * know it succeeded, how to integrate, how to get started), then states the five
 * onboarding stages and separates what works today from what is planned. Every
 * claim maps to a real route: `app/api/v1/checkouts/*`, `app/checkout/[token]`,
 * `lib/developer/*`. Nothing here is aspirational.
 */

/** The customer's real journey, one step per line so it reads on a phone. */
const LIFECYCLE = [
  {
    t: "You create the order",
    d: "One API call sets the recipient, the asset you want and the amount; a second wraps it in a checkout and returns a payment link.",
  },
  {
    t: "The customer opens the link",
    d: "The hosted page at /checkout/<token> shows the amount, asset and recipient. It carries no credential — the token authenticates the order.",
  },
  {
    t: "The customer reviews and connects a wallet",
    d: "They see exactly what they will receive and what they will spend. Any wallet that can reach Monad works.",
  },
  {
    t: "The customer authorizes",
    d: "Their own wallet signs and broadcasts. Intent Pay never holds a key and can never authorize on their behalf.",
  },
  {
    t: "Intent Pay verifies settlement",
    d: "The recipient's transfer is proven from the confirmed Monad receipt. A broadcast on its own is never treated as paid.",
  },
  {
    t: "You read the verified outcome",
    d: "Poll the order, fetch settlement evidence, or receive a signed webhook. The status is the verified on-chain result.",
  },
] as const;

/** The five onboarding stages, each answerable in a few lines. */
const STAGES = [
  {
    n: "1",
    t: "Understand",
    d: "A hosted checkout with payment links and QR codes over the versioned /api/v1 API. You create the order; the customer pays with their own wallet.",
  },
  {
    n: "2",
    t: "Requirements",
    d: "A server to hold your API key, a Monad receive address, and a way to share a link. No wallet or key custody is required of you.",
  },
  {
    n: "3",
    t: "Integrate",
    d: "Create an intent, wrap it in a checkout, share the link or QR, then read status or verify settlement. Server SDK or plain HTTP.",
  },
  {
    n: "4",
    t: "Test",
    d: "There is no sandbox — Intent Pay is Monad mainnet only. Test the integration logic locally; a real payment moves real funds.",
  },
  {
    n: "5",
    t: "Get your key",
    d: "Signup is self-service: register your email, open the verification link, and your first key is issued once. No operator needed.",
  },
] as const;

export default function Merchants() {
  return (
    <MarketingShell
      eyebrow="Merchants"
      title="Accept crypto without touching a swap screen"
      intro="Create an order, share a payment link or QR, and receive the exact asset you asked for. Your customer pays with their own wallet; settlement is verified on-chain before the order is marked paid."
      actions={
        <>
          <Link href="/docs/checkout" className="btn-primary">
            Checkout guide
          </Link>
          <Link href="/merchant" className="btn-ghost">
            Open the merchant console
          </Link>
        </>
      }
    >
      <Section
        title="How a customer pays"
        intro="The real flow, end to end. Only the customer's wallet ever authorizes a payment."
      >
        <ol className="space-y-3">
          {LIFECYCLE.map((step, i) => (
            <li key={step.t} className="card-flat flex gap-3 p-4">
              <span
                aria-hidden
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-mono/15 text-xs font-semibold text-mono-soft"
              >
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-white">{step.t}</span>
                <span className="mt-1 block text-sm leading-relaxed text-white/50">{step.d}</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        title="How you know payment succeeded"
        intro="The order reaches payment_verified only when the recipient's transfer is proven from the Monad receipt — never from a broadcast alone."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="card-flat p-4">
            <h3 className="text-sm font-semibold text-emerald-300/80">Verified</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              The recipient was paid on-chain in the requested asset. The order is complete, and the
              amount delivered is recorded.
            </p>
          </div>
          <div className="card-flat p-4">
            <h3 className="text-sm font-semibold text-amber-300/80">Pending or unknown</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              A transaction exists but is not confirmed, or its outcome is unknown. Shown as
              confirming — never as paid — and safely retryable.
            </p>
          </div>
        </div>
        <div className="mt-3">
          <Callout tone="info" title="One transaction pays one order">
            A hash is claimed durably on <Code>(chainId, txHash)</Code> when settlement is proven. A
            hash that already paid another order is refused with <Code>409 replay_detected</Code>. A
            short delivery (<Code>short</Code>) or a reverted transaction fails the order.
          </Callout>
        </div>
      </Section>

      <Section
        title="How to integrate"
        intro="Two calls to a payment link. Creating the checkout freezes the amount, asset and recipient, so a link can never change under a customer."
      >
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">
{`# 1. The payment intent — the recipient receives $25 worth of USDC
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/intents \\
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"recipient":"0x…","receiveToken":"USDC","amount":"25","amountMode":"recipient_receives"}'

# 2. The checkout — the response's "token" is the payment link handle
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/checkouts \\
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"intentId":"int_…","orderReference":"ORDER-1001"}'`}
          </pre>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-white/55">
          Your customer opens <Code>/checkout/&lt;token&gt;</Code>. The merchant console at{" "}
          <Link href="/merchant" className="text-mono-soft hover:underline">
            /merchant
          </Link>{" "}
          does the same two calls and renders the link and its QR — a real client of the public API,
          not a private path.
        </p>
      </Section>

      <Section
        title="Get started in five steps"
        intro="The whole onboarding path, from understanding the product to a production key."
      >
        <ol className="space-y-3">
          {STAGES.map((s) => (
            <li key={s.n} className="card-flat flex gap-3 p-4">
              <span
                aria-hidden
                className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-xs font-semibold text-white/70"
              >
                {s.n}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-white">{s.t}</span>
                <span className="mt-1 block text-sm leading-relaxed text-white/50">{s.d}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm leading-relaxed text-white/55">
          The full walkthrough — every endpoint, request and response — is in the{" "}
          <Link href="/docs/checkout" className="text-mono-soft hover:underline">
            checkout guide
          </Link>{" "}
          and the{" "}
          <Link href="/docs/api" className="text-mono-soft hover:underline">
            API reference
          </Link>
          .
        </p>
      </Section>

      <Section title="What is built today">
        <FeatureGrid
          items={[
            { t: "Hosted checkout page", d: "A public payment page at /checkout/<token> where the customer connects a wallet and pays in a few steps." },
            { t: "Payment links and QR", d: "Each checkout yields a shareable link and a QR code. The link expires (default 30 minutes, configurable 60–86400s)." },
            { t: "Exact-asset settlement", d: "You receive the token you asked for, verified on-chain — the customer's source asset is resolved for them." },
            { t: "Payment status and evidence", d: "Poll an order, or fetch its settlement evidence re-verified live against the Monad receipt." },
            { t: "Signed webhooks", d: "Register endpoints and receive order and payment events, signed with HMAC-SHA256 over the raw body, with retries and replay protection." },
            { t: "Idempotent requests", d: "An Idempotency-Key makes a retried create safe: you get the original order back, never a duplicate." },
            { t: "Per-order attribution", d: "Register a watch-only xpub and each order is paid to a unique derived destination, so a transfer can only settle the order it was created for." },
            { t: "Merchant console", d: "A browser console that creates links and watches orders — a real client of the same public API." },
          ]}
        />
      </Section>

      <Section title="Planned, not built">
        <div className="space-y-3 text-sm leading-relaxed text-white/55">
          <p className="text-pretty">
            There is no sandbox or testnet — Intent Pay is Monad mainnet only, so there is no
            risk-free mode that still proves a real payment. Refunds are not implemented; an
            overpayment is never refunded automatically. A transparent service fee is not charged
            today. Fiat off-ramp, automated reconciliation exports and multi-asset settlement
            reporting are not implemented. This page states them so the working surface is not
            over-claimed.
          </p>
        </div>
      </Section>

      <Section title="Next">
        <div className="grid gap-3 sm:grid-cols-2">
          <NextStep href="/docs/checkout" label="Checkout guide" body="The two-step model and every customer route" />
          <NextStep href="/docs/api" label="API reference" body="Endpoints, request and response shapes" />
          <NextStep href="/docs/quickstart" label="Quickstart" body="Authenticate, create, prepare, submit, verify" />
          <NextStep href="/docs/security" label="Security model" body="Non-custodial principles and verification" />
        </div>
      </Section>
    </MarketingShell>
  );
}
