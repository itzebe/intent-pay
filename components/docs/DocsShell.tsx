import type { ReactNode } from "react";
import Link from "next/link";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";

const NAV = [
  { title: "Documentation", links: [
    { href: "/docs", label: "Overview" },
    { href: "/docs/litepaper", label: "Litepaper" },
    { href: "/docs/how-it-works", label: "How It Works" },
    { href: "/docs/architecture", label: "Technical Architecture" },
  ] },
  { title: "Trust", links: [
    { href: "/docs/security", label: "Security & Trust" },
    { href: "/docs/roadmap", label: "Roadmap" },
    { href: "/docs/faq", label: "FAQ" },
  ] },
  { title: "Build", links: [
    { href: "/docs/quickstart", label: "Quickstart" },
    { href: "/docs/developers", label: "Developer Guide" },
    { href: "/docs/api", label: "Developer API" },
    { href: "/docs/checkout", label: "Merchant Checkout" },
  ] },
] as const;

/**
 * Shared shell for every documentation route.
 *
 * A server component so the docs pages stay static and directly navigable
 * (shareable, bookmarkable, refreshable). It reuses the one site header, so the
 * primary navigation and the logo cannot drift from the app, and keeps the
 * primary action ("Open the app") one tap away. The sidebar collapses above the
 * content on small screens so the body text keeps the full width on mobile.
 */
export function DocsShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <SiteHeader
        subtitle="Documentation"
        actions={
          <Link href="/" className="btn-primary !px-4 !py-2 text-xs">
            Open the app
          </Link>
        }
      />

      <div className="mx-auto max-w-6xl px-5 py-8 sm:py-12">
        <div className="lg:flex lg:gap-10">
          <aside className="mb-8 lg:mb-0 lg:w-60 lg:shrink-0">
            <nav aria-label="Documentation" className="flex flex-wrap gap-x-6 gap-y-4 lg:block lg:space-y-6">
              {NAV.map((group) => (
                <div key={group.title}>
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/35">
                    {group.title}
                  </div>
                  <ul className="flex flex-wrap gap-x-5 gap-y-1.5 lg:block lg:space-y-1.5">
                    {group.links.map((l) => (
                      <li key={l.href}>
                        <Link
                          href={l.href}
                          className="block rounded-lg px-2 py-1 text-sm text-white/55 transition hover:bg-white/[0.04] hover:text-white"
                        >
                          {l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </aside>

          <article className="min-w-0 flex-1 space-y-8">{children}</article>
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}

export function DocTitle({ eyebrow, title, intro }: { eyebrow?: string; title: string; intro?: string }) {
  return (
    <header className="border-b border-white/[0.06] pb-6">
      {eyebrow && (
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-mono-soft">
          {eyebrow}
        </div>
      )}
      <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-4xl">{title}</h1>
      {intro && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55 sm:text-base">{intro}</p>}
    </header>
  );
}
