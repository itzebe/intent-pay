import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell, Section, FeatureGrid, NextStep } from "@/components/landing/MarketingShell";
import { Lifecycle, WhyMonad } from "@/components/landing/HomeSections";
import { Bolt, Code, Shield, Store } from "@/components/ui/Icons";

export const metadata: Metadata = {
  title: "Product — Intent Pay",
  description:
    "How Intent Pay works: the payment lifecycle from intent to verified settlement, what the system does for individuals, developers and merchants, and where the honest limits are.",
};

/**
 * `/product` — the product explanation.
 *
 * It describes the real lifecycle the code runs and the three audiences, and
 * links to the working surfaces. No invented capability: every statement maps to
 * behaviour that exists in the repository.
 */
export default function Product() {
  return (
    <MarketingShell
      eyebrow="Product"
      title="Payments that start from an outcome, not a token"
      intro="Intent Pay is payment infrastructure on Monad. You say who receives, how much and which token — and the system works out which asset you spend, the route, and the transaction. You stay in control of authorization, and settlement is verified on-chain."
      actions={
        <>
          <Link href="/#pay" className="btn-primary">
            <Bolt className="h-4 w-4" /> Try the payment experience
          </Link>
          <Link href="/docs/how-it-works" className="btn-ghost">
            Read how it works
          </Link>
        </>
      }
    >
      <Section
        title="The problem"
        intro="On-chain payments assume the sender already holds the exact asset the recipient wants."
      >
        <div className="space-y-3 text-sm leading-relaxed text-white/60">
          <p className="text-pretty">
            A recipient wants USDC. The sender holds MON, WETH, or a long tail of tokens. Today that
            forces the sender into a swap interface: pick a pair, pick a fee tier, estimate slippage,
            approve, swap, then send — and hope the amount that lands is the amount that was meant.
          </p>
          <p className="text-pretty">
            The payment itself — <em>this recipient receives this amount of this token</em> — is lost
            inside a trading workflow. Intent Pay puts the payment back at the centre and treats the
            routing, slippage bound and calldata as machinery the user should not have to reason
            about.
          </p>
        </div>
      </Section>

      <Section
        title="How the payment resolves"
        intro="Five stages. The first two are the system's job; the last three are visible to you."
      >
        <div className="mt-1" />
      </Section>
      <Lifecycle />

      <WhyMonad />

      <Section title="What is real today">
        <FeatureGrid
          items={[
            { t: "Live Monad Mainnet", d: "Chain id 143. Balances, prices, routes and receipts are read from and written to the real chain — no simulated ledger." },
            { t: "Live Uniswap V3 routing", d: "Exact-output and exact-input quoting across every fee tier, with an honest route_unavailable when no pool exists." },
            { t: "Protected execution", d: "Every swap step carries a real on-chain minimum output. The signing guard rebuilds from fresh data and refuses on any change." },
            { t: "Verified settlement", d: "The recipient's transfer is proven from the confirmed receipt. Unverified delivery is never shown as success." },
            { t: "Multi-wallet connectivity", d: "EIP-6963 injected-wallet discovery with a legacy fallback, plus WalletConnect mobile and QR wallets when configured." },
            { t: "Natural-language intents", d: "A deterministic, offline parser turns a sentence into the same intent the form produces. AI is optional and can only fill gaps." },
          ]}
        />
      </Section>

      <Section title="Who it is for">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card-flat p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-mono-soft">
              <Bolt className="h-4 w-4" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-white">Individuals</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              Send someone the token they asked for, paying with whatever you already hold.
            </p>
            <Link href="/#pay" className="mt-3 inline-block text-xs font-medium text-mono-soft hover:underline">
              Open the composer →
            </Link>
          </div>
          <div className="card-flat p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-mono-soft">
              <Code className="h-4 w-4" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-white">Developers</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              A versioned HTTP API and a TypeScript SDK for intents, settlement and webhooks.
            </p>
            <Link href="/developers" className="mt-3 inline-block text-xs font-medium text-mono-soft hover:underline">
              Developer guide →
            </Link>
          </div>
          <div className="card-flat p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-mono-soft">
              <Store className="h-4 w-4" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-white">Merchants</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              A checkout link or QR your customers pay with their own wallet; you receive the asset
              you asked for.
            </p>
            <Link href="/merchants" className="mt-3 inline-block text-xs font-medium text-mono-soft hover:underline">
              Merchant checkout →
            </Link>
          </div>
        </div>
      </Section>

      <Section
        title="You keep your keys"
        intro="Intent Pay is non-custodial and never signs on your behalf."
      >
        <div className="card-flat flex items-start gap-3 p-4">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300/70" />
          <p className="text-sm leading-relaxed text-white/55">
            Authorization always happens in your own wallet. Intent Pay never asks for a seed phrase
            or private key, never holds a key, and never broadcasts a transaction you did not
            approve. A single approval maps to a single submission — the submission is never retried.
          </p>
        </div>
      </Section>

      <Section title="Honest limits">
        <div className="space-y-2 text-sm leading-relaxed text-white/55">
          <p className="text-pretty">
            Monad only — Intent Pay is not a bridge and does not claim cross-chain delivery. Gas is
            always paid in native MON; there is no sponsored or gasless path. A route that does not
            exist fails honestly rather than producing a fabricated quote. Live-route coverage for the
            long tail of tokens keeps expanding.
          </p>
          <p className="text-pretty">
            See <Link href="/docs/security" className="text-mono-soft hover:underline">Security &amp; Trust</Link> and{" "}
            <Link href="/docs/faq" className="text-mono-soft hover:underline">the FAQ</Link> for the full, current picture.
          </p>
        </div>
      </Section>

      <Section title="Next">
        <div className="grid gap-3 sm:grid-cols-2">
          <NextStep href="/developers" label="Developer guide" body="API, SDK and integration examples" />
          <NextStep href="/merchants" label="Merchant checkout" body="Payment links, QR and settlement" />
        </div>
      </Section>
    </MarketingShell>
  );
}
