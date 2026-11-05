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
          <LI><Code>pending</Code> / <Code>unconfirmed</Code> — a transaction exists but is not yet confirmed (or not yet past the finality policy). Retryable.</LI>
          <LI><Code>not_found</Code> / <Code>unavailable</Code> — retryable; never treated as success.</LI>
          <LI><Code>short</Code> — the recipient received less than intended. The order fails.</LI>
          <LI><Code>reverted</Code> — the transaction failed on-chain. The order fails.</LI>
          <LI><Code>historical</Code> — the transaction predates the order, so it is not this order&apos;s payment. The order fails.</LI>
        </UL>
        <P>
          One transaction pays one order: a hash is claimed durably on
          <Code>(chainId, txHash)</Code> when settlement is proven, and a hash that already paid
          another order is refused with <Code>409 replay_detected</Code>. A <Code>verified</Code>
          order records the exact amount delivered; an overpayment is never refunded automatically.
        </P>
      </DocSection>

      <DocSection title="Attribute a payment to a specific order">
        <P>
          By default every order shares your recipient address, so a payment is attributed by the
          token, amount and time guards. To make attribution exact, register a{" "}
          <strong>watch-only payment xpub</strong> — a BIP32 public extended key (<Code>xpub…</Code>).
          Each checkout is then paid to a <strong>unique destination</strong> derived for that order,
          so a transfer can only settle the order it was created for.
        </P>
        <Code>{`curl -s -X POST https://intent-pay-roan.vercel.app/api/v1/attribution \\
  -H "Authorization: Bearer ipk_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"paymentXpub":"xpub6…"}'`}</Code>
        <UL>
          <LI>
            <strong>Public key only.</strong> A private key (<Code>xprv…</Code>) or a seed phrase is
            refused, so Intent Pay can never spend. The xpub itself is never returned by the API.
          </LI>
          <LI>
            <Code>GET /api/v1/attribution</Code> — whether attribution is on, the next index, and a
            preview of upcoming destinations.
          </LI>
          <LI>
            <Code>POST /api/v1/attribution</Code> with <Code>{`{"paymentXpub":null}`}</Code> —
            disable and fall back to the shared recipient.
          </LI>
          <LI>
            Each checkout reports its <Code>attribution.mode</Code> —{" "}
            <Code>checkout_bound</Code> (a unique destination) or <Code>shared_recipient</Code>. The
            two are never presented as equivalent.
          </LI>
          <LI>
            <strong>Not retroactive.</strong> Registering or replacing an xpub only affects checkouts
            created afterwards; existing orders keep the destination they were bound to. (One
            exception: an order bound before 2026-11-05 with a superseded derivation is re-derived to
            your real address when it is read, so no customer is ever sent to an unspendable
            destination.)
          </LI>
          <LI>
            <strong>You sweep.</strong> Derived addresses are ordinary receive addresses of your
            wallet — the <Code>m/0/&lt;index&gt;</Code> external chain of the account the xpub belongs
            to. Intent Pay watches them and can never move funds; collect them with the wallet that
            holds the matching seed.
          </LI>
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
          <LI><Code>GET/POST /api/v1/attribution</Code> — read or set per-order attribution.</LI>
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
