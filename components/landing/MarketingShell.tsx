import type { ReactNode } from "react";
import Link from "next/link";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { ArrowRight } from "@/components/ui/Icons";

/**
 * Shell for the top-level product pages (/product, /developers, /merchants).
 *
 * Server component: static and directly navigable. It reuses the one site
 * header and footer so navigation cannot drift, and renders a consistent
 * page header so the three pages read as one product, not three microsites.
 */
export function MarketingShell({
  eyebrow,
  title,
  intro,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <SiteHeader
        actions={
          <Link href="/" className="btn-primary !px-4 !py-2 text-xs">
            Open the app
          </Link>
        }
      />

      <main className="pb-24">
        <header className="mx-auto max-w-4xl px-5 pb-4 pt-14 sm:pt-20">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-mono-soft">
            {eyebrow}
          </div>
          <h1 className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 max-w-2xl text-pretty text-base leading-relaxed text-white/55">
            {intro}
          </p>
          {actions && <div className="mt-6 flex flex-wrap gap-3">{actions}</div>}
        </header>

        {children}
      </main>

      <SiteFooter />
    </div>
  );
}

/** A titled block of page content with a consistent rhythm. */
export function Section({
  id,
  title,
  intro,
  children,
}: {
  id?: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-4xl scroll-mt-24 px-5 pt-14">
      <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h2>
      {intro && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">{intro}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function FeatureGrid({ items }: { items: { t: string; d: string }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.t} className="card-flat p-4">
          <h3 className="text-sm font-semibold text-white">{it.t}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-white/50">{it.d}</p>
        </div>
      ))}
    </div>
  );
}

export function NextStep({ href, label, body }: { href: string; label: string; body: string }) {
  return (
    <Link
      href={href}
      className="card-flat group flex items-center justify-between gap-4 p-4 transition hover:border-mono/30 hover:bg-white/[0.04]"
    >
      <span>
        <span className="block text-sm font-semibold text-white">{label}</span>
        <span className="mt-0.5 block text-xs text-white/45">{body}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-mono-soft transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
