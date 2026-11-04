import type { Metadata } from "next";
import Link from "next/link";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI, Code, Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Merchant Checkout — Intent Pay",
  description:
    "Accept crypto payments with a checkout link. Create an order, share a link or QR, and let the customer pay with their own wallet while you receive the exact asset you asked for.",
};

/**
 * The merchant checkout guide.
 *
 * It documents the two-step model (intent → checkout), the public customer
 * routes, and the honesty rules — a broadcast is not a payment until `/verify`
 * proves it on-chain.
 */
export default function CheckoutDocs() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Merchant Checkout"
        title="Accept crypto payments with a link"
        intro="Create an order, share a payment link or QR code, and receive the exact asset you asked for. Your customer pays with their own wallet; settlement is verified on-chain."
      />

      <DocSection title="The model: an intent, then a checkout">
        <P>
          A <strong>checkout</strong> is a payable order bound to a payment{" "}
          <Link href="/docs/api" className="text-mono-soft hover:underline">
            intent
          </Link>
          . You create the intent first (amount, asset, recipient), then wrap it in a checkout to
          obtain a public payment link. Creating the checkout <strong>freezes</strong> the intent&apos;s
          parameters and authorizes it for payment — the amount, asset and recipient can never
          change once a link exists.
        </P>
        <UL>
          <LI>One intent has at most one checkout. A second create returns the original link.</LI>
          <LI>The public handle is a random <Code>chk_…</Code> token. Only its hash is stored.</LI>
          <LI>The link expires (default 30 minutes, 60–86400 seconds) and then cannot be paid.</LI>
        </UL>
      </DocSection>

      <DocSection title="Create a checkout">
        <P>Two calls, both authenticated with your merchant API key:</P>
        <div className="card-flat overflow-x-auto p-4">
          <pre className="font-mono text-xs leading-relaxed text-white/70">{`# 1. The payment intent
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/intents \\
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"recipient":"0x…","receiveToken":"USDC","amount":"25","amountMode":"recipient_receives"}'

# 2. The checkout — the response's "token" is the payment link handle
curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/checkouts \\
  -H "Authorization: Bearer ipk_live_<prefix>.<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"intentId":"int_…","orderReference":"ORDER-1001"}'`}</pre>
        </div>
        <P>
          The customer opens <Code>https://intent-pay-roan.vercel.app/checkout/&lt;token&gt;</Code>.
          The page carries no credential — the token in the URL authenticates the order.
        </P>
      </DocSection>

      <DocSection title="Customer routes (public)">
        <P>
          These routes are authenticated by the checkout token, not an API key. They are what the
          hosted payment page uses, and what a fully custom front end would call.
        </P>
        <UL>
          <LI><Code>GET /api/checkout/&lt;token&gt;</Code> — the order, its status and any tx hashes.</LI>
          <LI><Code>POST /api/checkout/&lt;token&gt;/prepare</Code> — build the calls for a sender address.</LI>
          <LI><Code>POST /api/checkout/&lt;token&gt;/submit</Code> — record the customer&apos;s broadcast hash(es).</LI>
          <LI><Code>POST /api/checkout/&lt;token&gt;/verify</Code> — independently verify settlement.</LI>
        </UL>
        <Callout>
          The merchant key can <strong>build</strong> and <strong>verify</strong>, but it can never
          authorize a payment. Only the customer&apos;s own wallet signs and broadcasts.
        </Callout>
      </DocSection>

      <DocSection title="Settlement is verified, never assumed">
        <P>
          A submitted transaction is not a payment. The order reaches{" "}
          <Code>payment_verified</Code> only when <Code>/verify</Code> reads the authoritative Monad
          receipt and proves the recipient received the expected amount in the requested asset.
          Until then the page shows &quot;Confirming&quot;, never &quot;paid&quot;.
        </P>
        <UL>
          <LI><Code>verified</Code> — the recipient was paid on-chain. The order is complete.</LI>
          <LI><Code>pending</Code> — a transaction exists but is not yet confirmed. Retryable.</LI>
          <LI><Code>not_found</Code> / <Code>unavailable</Code> — retryable; never treated as success.</LI>
          <LI><Code>contradictory</Code> — the transaction did not deliver what was promised.</LI>
        </UL>
      </DocSection>

      <DocSection title="Manage orders">
        <UL>
          <LI><Code>GET /api/v1/checkouts</Code> — list your orders, newest first.</LI>
          <LI><Code>GET /api/v1/checkouts/:id</Code> — one order and its bound intent.</LI>
          <LI><Code>POST /api/v1/checkouts/:id/prepare</Code> — build the calls (e.g. for your own UI).</LI>
          <LI><Code>POST /api/v1/checkouts/:id/submit</Code> — record a broadcast hash.</LI>
          <LI><Code>POST /api/v1/checkouts/:id/verify</Code> — verify settlement.</LI>
          <LI><Code>POST /api/v1/checkouts/:id/cancel</Code> — cancel an unpaid order.</LI>
          <LI><Code>GET /api/v1/checkouts/:id/evidence</Code> — settlement evidence, re-verified live.</LI>
        </UL>
      </DocSection>

      <DocSection title="The merchant console">
        <P>
          A working console lives at{" "}
          <Link href="/merchant" className="text-mono-soft hover:underline">
            /merchant
          </Link>
          . Paste a developer API key, create a payment link, and share it as a URL or QR code. It is
          a thin client of the same public API documented here — no private endpoints.
        </P>
      </DocSection>
    </DocsShell>
  );
}
