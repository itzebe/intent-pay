import type { ReactNode } from "react";

/** Small typographic primitives for the documentation pages. */

export function DocSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-white/60">{children}</div>
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-pretty">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="ml-4 list-disc space-y-1.5 marker:text-mono-soft/70">{children}</ul>;
}

export function OL({ children }: { children: ReactNode }) {
  return <ol className="ml-4 list-decimal space-y-1.5 marker:text-mono-soft/70">{children}</ol>;
}

export function LI({ children }: { children: ReactNode }) {
  return <li className="text-pretty">{children}</li>;
}

const CALLOUT_TONES = {
  info: "border-mono/25 bg-mono/[0.06] text-white/70",
  warn: "border-amber-400/25 bg-amber-400/[0.06] text-amber-100/80",
  ok: "border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-100/80",
} as const;

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: keyof typeof CALLOUT_TONES;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm leading-relaxed ${CALLOUT_TONES[tone]}`}>
      {title && <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em]">{title}</div>}
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="card-flat p-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-white/35">{label}</div>
      <div className="mt-1 text-sm font-medium text-white/85">{value}</div>
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-white/80">
      {children}
    </code>
  );
}
