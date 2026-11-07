import Link from "next/link";
import { ArrowRight, Code, Store, User } from "@/components/ui/Icons";

/**
 * The three product pathways. Each answers "what is this for me?" and links to
 * the real surface: the composer, the developer docs, the merchant docs.
 * Presentation only — the destinations are the pages that already exist.
 */
const PATHWAYS = [
  {
    href: "#pay",
    icon: User,
    audience: "Individuals",
    title: "Pay someone in any token",
    body: "State the recipient, the amount and the token they receive. Intent Pay reads your real balances, finds the route, and prepares one transaction you approve in your wallet.",
    cta: "Open the composer",
  },
  {
    href: "/developers",
    icon: Code,
    audience: "Developers",
    title: "Build on the payment API",
    body: "A versioned HTTP API and a TypeScript SDK for intents, settlement and webhooks. Create an intent, prepare the calls, and verify settlement on-chain.",
    cta: "Read the developer guide",
  },
  {
    href: "/merchants",
    icon: Store,
    audience: "Merchants",
    title: "Accept crypto checkout",
    body: "Create an order, share a payment link or QR, and receive the exact asset you asked for. Your customer pays with their own wallet; settlement is verified on-chain.",
    cta: "See merchant checkout",
  },
] as const;

export function Pathways() {
  return (
    <section id="pathways" className="mx-auto max-w-6xl scroll-mt-24 px-5 pt-16">
      <header className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
          One payment layer, three ways in
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          The same intent — who receives, how much, which token — powers all three. Pick the path
          that fits you; each one leads to the surface that already exists.
        </p>
      </header>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {PATHWAYS.map((p) => {
          const Icon = p.icon;
          const external = p.href.startsWith("#");
          const inner = (
            <>
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.03] text-mono-soft">
                <Icon className="h-4 w-4" />
              </span>
              <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
                {p.audience}
              </div>
              <h3 className="mt-1 text-base font-semibold tracking-tight text-white">{p.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-white/55">{p.body}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-mono-soft">
                {p.cta}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </>
          );
          const className =
            "card-flat group flex flex-col p-5 transition hover:border-mono/30 hover:bg-white/[0.04]";
          return external ? (
            <a key={p.audience} href={p.href} className={className}>
              {inner}
            </a>
          ) : (
            <Link key={p.audience} href={p.href} className={className}>
              {inner}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The payment lifecycle, stated once and reused on the homepage and the product
 * page. It is the same five stages the code actually runs: intent → preparation
 * → authorization → submission → verification. No invented stages.
 */
const LIFECYCLE = [
  { n: "01", t: "Payment intent", d: "You say who receives, how much and which token — an outcome, not a trade." },
  { n: "02", t: "Transaction preparation", d: "Intent Pay resolves the source asset, the route and the envelope (gas, fees, nonce)." },
  { n: "03", t: "User authorization", d: "You review the exact transaction and approve it in your own wallet. Keys never leave the wallet." },
  { n: "04", t: "Transaction submission", d: "Submitted once, never retried. A single approval maps to a single broadcast." },
  { n: "05", t: "Settlement verification", d: "The recipient's real transfer is proven from the confirmed receipt — not assumed." },
] as const;

export function Lifecycle() {
  return (
    <section id="lifecycle" className="mx-auto max-w-6xl scroll-mt-24 px-5 pt-16">
      <header className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
          The payment lifecycle
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          You keep control of wallet authorization. Intent Pay prepares and verifies; it never
          holds your keys and never signs on your behalf.
        </p>
      </header>

      <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {LIFECYCLE.map((s) => (
          <li key={s.n} className="card-flat flex flex-col p-4">
            <span className="num text-xs font-bold text-mono-soft">{s.n}</span>
            <h3 className="mt-2 text-sm font-semibold text-white">{s.t}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-white/55">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Why Monad. Answers "why this chain?" honestly: what the product actually uses
 * and what it does not claim. Every point maps to a real property of the
 * deployment (chain id 143, low fees, Uniswap V3 routing, EVM tooling) — no
 * endorsement, partnership or performance claim is implied.
 */
const MONAD_POINTS = [
  { t: "Low, predictable fees", d: "A payment is one or a few transactions. Monad's low network cost keeps a small payment worth making." },
  { t: "Fast confirmation", d: "Payments settle quickly, so a merchant checkout confirms in seconds rather than minutes." },
  { t: "EVM, so real tooling", d: "Intent Pay routes through Uniswap V3 and reads receipts with standard EVM clients — no bespoke chain integration." },
  { t: "A payment-shaped network", d: "A high-throughput EVM chain is a natural home for payments that resolve routing behind a simple intent." },
] as const;

export function WhyMonad() {
  return (
    <section id="why-monad" className="mx-auto max-w-6xl scroll-mt-24 px-5 pt-16">
      <header className="max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">Why Monad</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Intent Pay runs on Monad Mainnet (chain id 143) because a payment wants low fees and fast
          finality. It is independent infrastructure — not affiliated with, endorsed by or sponsored
          by the Monad Foundation.
        </p>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {MONAD_POINTS.map((p) => (
          <div key={p.t} className="card-flat p-4">
            <h3 className="text-sm font-semibold text-white">{p.t}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-white/55">{p.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

