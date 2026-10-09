import type { Metadata } from "next";
import Link from "next/link";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { P, UL, LI, Callout } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Documentation — Intent Pay",
  description:
    "Overview of Intent Pay: intent-based payments on Monad mainnet. What it does, how it works, its capabilities and its limits.",
};

const CARDS = [
  { href: "/docs/litepaper", t: "Litepaper", d: "The complete design: problem, approach, architecture, execution, limits and roadmap." },
  { href: "/docs/how-it-works", t: "How It Works", d: "The payment journey from intent to verified onchain status." },
  { href: "/docs/architecture", t: "Technical Architecture", d: "The layered system: intent, routing, construction, execution, verification." },
  { href: "/docs/security", t: "Security & Trust", d: "The signing guard, on-chain output bounds and honest capability reporting." },
  { href: "/docs/roadmap", t: "Roadmap", d: "What is built and verified, what is in progress, and what is planned." },
  { href: "/docs/faq", t: "FAQ", d: "Direct answers about tokens, gas, fees, safety and network support." },
  { href: "/docs/developers", t: "Developers", d: "Repository layout, commands, routes and configuration." },
] as const;

export default function DocsIndex() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Documentation"
        title="Intent Pay"
        intro="An intent-based payment layer for Monad. You state what the recipient should receive; Intent Pay determines which asset you spend, the route, and the transaction — then you approve it in your own wallet."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="card-flat group p-4 transition hover:border-mono/30 hover:bg-white/[0.04]"
          >
            <div className="text-sm font-semibold text-white group-hover:text-mono-soft">{c.t}</div>
            <p className="mt-1 text-xs leading-relaxed text-white/45">{c.d}</p>
          </Link>
        ))}
      </div>

      <div className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">The idea in one paragraph</h2>
        <P>
          A payment is a statement about an outcome: <em>this recipient receives this token, worth
          this amount</em>. Everything else — which of your balances to spend, how much of it, the
          conversion route, the slippage bound, the calldata, the receipt check — is machinery the
          user should not have to reason about. Intent Pay keeps the user&apos;s mental model a payment
          rather than a trade, while being completely honest about what that machinery can and
          cannot currently do on Monad.
        </P>
      </div>

      <div className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">At a glance</h2>
        <UL>
          <LI>
            <strong className="text-white/80">Network:</strong> Monad mainnet, chain id 143.
          </LI>
          <LI>
            <strong className="text-white/80">Simplicity on top:</strong> a single-page, Web2-style
            payment composer plus an optional natural-language intent bar.
          </LI>
          <LI>
            <strong className="text-white/80">Routing underneath:</strong> live Uniswap V3 routing on
            Monad, exact-output and exact-input, every fee tier quoted.
          </LI>
          <LI>
            <strong className="text-white/80">Discovery:</strong> tokens resolve by symbol, name or
            contract address from real Monad chain state — not a fixed allow-list.
          </LI>
          <LI>
            <strong className="text-white/80">Gas:</strong> always paid in native MON through your
            own injected wallet. There is no sponsored or ERC-20 gas path.
          </LI>
          <LI>
            <strong className="text-white/80">Execution:</strong> one prepared transaction, protected
            by an on-chain minimum output and a signing guard that rebuilds it from fresh data.
          </LI>
        </UL>
      </div>

      <Callout tone="warn" title="Scope of these documents">
        This documentation describes the implementation as built. It distinguishes verified
        functionality, implemented-but-unverified functionality, in-progress work and future plans,
        and does not claim integrations, audits, partnerships or performance figures that the
        repository does not support.
      </Callout>
    </DocsShell>
  );
}
