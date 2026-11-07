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
        <p className="mt-2 text-sm leading-relaxed text-white/55">
          Intent Pay is payment infrastructure: an intent describes the outcome, and the system
          resolves the asset, the route and the transaction. Choose the path that fits you.
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
              <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/40">
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
  { n: "01", t: "Payment intent", d: "The recipient, the amount and the token they should receive — stated as an outcome." },
  { n: "02", t: "Transaction preparation", d: "The app resolves the source asset, the route and the envelope (gas, fees, nonce)." },
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
        <p className="mt-2 text-sm leading-relaxed text-white/55">
          You keep control of wallet authorization. Intent Pay prepares and verifies; it never
          holds your keys and never signs on your behalf.
        </p>
      </header>

      <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {LIFECYCLE.map((s) => (
          <li key={s.n} className="card-flat flex flex-col p-4">
            <span className="num text-xs font-bold text-mono-soft">{s.n}</span>
            <h3 className="mt-2 text-sm font-semibold text-white">{s.t}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-white/50">{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
