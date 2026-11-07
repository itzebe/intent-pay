"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Close, Menu } from "@/components/ui/Icons";

/**
 * The one site header, shared by the app and every documentation page.
 *
 * Presentation-only: it renders navigation and a right-hand action slot. The app
 * passes the wallet `ConnectButton`; the documentation pages pass a plain link to
 * the app (they have no wallet provider). Keeping one header means the primary
 * navigation and the logo cannot drift between routes.
 */
const NAV = [
  { href: "/product", label: "Product" },
  { href: "/developers", label: "Developers" },
  { href: "/merchants", label: "Merchants" },
  { href: "/docs", label: "Documentation" },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/docs") return pathname === "/docs" || pathname.startsWith("/docs/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader({
  actions,
  subtitle = "Payments on Monad",
}: {
  actions?: ReactNode;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu on navigation and on Escape.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.05] bg-ink-950/75 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3.5">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Intent Pay home">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-mono to-mono-deep text-sm font-black text-white shadow-glow">
            ⌁
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold tracking-tight text-white">Intent Pay</span>
            <span className="hidden text-[10px] uppercase tracking-[0.16em] text-white/55 sm:block">
              {subtitle}
            </span>
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-0.5 md:flex">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  active ? "text-white" : "text-white/60 hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 sm:flex">{actions}</div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-white/70 transition hover:bg-white/[0.06] hover:text-white md:hidden"
          >
            {open ? <Close className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div id="site-menu" className="border-t border-white/[0.06] bg-ink-950/95 md:hidden">
          <nav aria-label="Mobile" className="mx-auto max-w-6xl px-5 py-3">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`block rounded-xl px-3 py-3 text-sm font-medium transition ${
                    active ? "bg-white/[0.05] text-white" : "text-white/70 hover:bg-white/[0.04] hover:text-white"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {actions && (
              <div className="mt-2 border-t border-white/[0.06] px-1 pt-3 sm:hidden">{actions}</div>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
