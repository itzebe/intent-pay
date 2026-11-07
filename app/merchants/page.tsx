import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell, Section, FeatureGrid, NextStep } from "@/components/landing/MarketingShell";
import { Code } from "@/components/docs/Prose";
import { Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Merchants — Intent Pay",
  description:
    "Accept crypto payments with a checkout link or QR. Your customer pays with their own wallet; you receive the exact asset you asked for, with settlement verified on-chain.",
};

/**
 * `/merchants` — the merchant entry point.
 *
 * It describes the real checkout flow (intent → checkout → hosted payment page)
 * and clearly separates what works today from what is planned. The working
 * capabilities map to `app/api/v1/checkouts/*` and `app/checkout/[token]`.
 */
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
        title="Two calls to a payment link"
        intro="Create the intent, wrap it in a checkout, and share the link or QR. Creating the checkout freezes the parameters."
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
          Your customer opens <Code>/checkout/&lt;token&gt;</Code>. That page carries no credential —
          the token in the URL authenticates the order.
        </p>
      </Section>

      <Section
        title="A broadcast is not a payment"
        intro="The order reaches payment_verified only when the recipient's transfer is proven from the Monad receipt."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="card-flat p-4">
            <h3 className="text-sm font-semibold text-emerald-300/80">Verified</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              The recipient was paid on-chain in the requested asset. The order is complete.
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

      <Section title="What is built today">
        <FeatureGrid
          items={[
            { t: "Hosted checkout page", d: "A public payment page at /checkout/<token> where the customer connects a wallet and pays in a few steps." },
            { t: "Payment links and QR", d: "Each checkout yields a shareable link and a QR code. The link expires (default 30 minutes, configurable)." },
            { t: "Exact-asset settlement", d: "You receive the token you asked for, verified on-chain — the customer's source asset is resolved for them." },
            { t: "Per-order attribution", d: "Register a watch-only xpub and each order is paid to a unique derived destination, so a transfer can only settle the order it was created for." },
            { t: "Webhooks", d: "Register endpoints and receive checkout.created, checkout.expired and payment events, with signature verification." },
            { t: "Merchant console", d: "A browser console that creates links and watches orders — a real client of the same public API." },
          ]}
        />
      </Section>

      <Section title="Planned, not built">
        <div className="space-y-3 text-sm leading-relaxed text-white/55">
          <p className="text-pretty">
            A transparent service fee is not charged today; if added, it would be disclosed on-screen
            before the customer authorizes. Fiat off-ramp, automated reconciliation exports and
            multi-asset settlement reporting are not implemented. This page states them so the
            working surface is not over-claimed.
          </p>
        </div>
      </Section>

      <Section title="Next">
        <div className="grid gap-3 sm:grid-cols-2">
          <NextStep href="/docs/checkout" label="Checkout guide" body="The two-step model and every customer route" />
          <NextStep href="/docs/api" label="API reference" body="Endpoints, request and response shapes" />
          <NextStep href="/developers" label="Developer guide" body="SDK, server/browser split and error handling" />
          <NextStep href="/docs/security" label="Security model" body="Non-custodial principles and verification" />
        </div>
      </Section>
    </MarketingShell>
  );
}
