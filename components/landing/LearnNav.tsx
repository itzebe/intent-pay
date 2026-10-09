"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "@/components/ui/Icons";

const LEARN_LINKS = [
  { href: "/docs", label: "Overview", blurb: "What Intent Pay is and what it does" },
  { href: "/docs/litepaper", label: "Litepaper", blurb: "The full design, end to end" },
  { href: "/docs/how-it-works", label: "How It Works", blurb: "The payment journey, step by step" },
  { href: "/docs/architecture", label: "Technical Architecture", blurb: "Layers, routing and execution" },
  { href: "/docs/security", label: "Security & Trust", blurb: "Guards, bounds and honest limits" },
  { href: "/docs/roadmap", label: "Roadmap", blurb: "Built, in progress, and planned" },
  { href: "/docs/faq", label: "FAQ", blurb: "Straight answers to common questions" },
] as const;

/**
 * Compact "Learn" navigation. Keeps the homepage focused on payments while
 * making the documentation reachable. Uses a click toggle (not hover) so it
 * works on touch devices, and closes on outside click, Escape, or navigation.
 */
export function LearnNav() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white/70 transition hover:bg-white/[0.04] hover:text-white"
      >
        Learn
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-[min(20rem,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-white/[0.08] bg-ink-850/95 p-1.5 shadow-2xl backdrop-blur-xl"
        >
          {LEARN_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-xl px-3 py-2.5 transition hover:bg-white/[0.05]"
            >
              <div className="text-sm font-medium text-white/90">{l.label}</div>
              <div className="text-xs text-white/40">{l.blurb}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
