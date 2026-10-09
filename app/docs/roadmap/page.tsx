import type { Metadata } from "next";
import { DocsShell, DocTitle } from "@/components/docs/DocsShell";
import { DocSection, P, UL, LI } from "@/components/docs/Prose";

export const metadata: Metadata = {
  title: "Roadmap — Intent Pay",
  description:
    "What Intent Pay has built, what is in progress, and what is explicitly out of scope. No promised dates or invented commitments.",
};

const STATUS = {
  built: {
    label: "Built",
    tone: "border-emerald-400/25 bg-emerald-400/[0.06]",
    badge: "text-emerald-300/80",
  },
  progress: {
    label: "In progress",
    tone: "border-amber-400/25 bg-amber-400/[0.06]",
    badge: "text-amber-300/80",
  },
  planned: {
    label: "Planned",
    tone: "border-mono/25 bg-mono/[0.06]",
    badge: "text-mono-soft",
  },
} as const;

const ITEMS: { status: keyof typeof STATUS; title: string; detail: string }[] = [
  { status: "built", title: "Intent model and canonical state", detail: "One canonical payment state shared by the chat, composer, quote, plan and signing guard." },
  { status: "built", title: "Deterministic natural-language parsing", detail: "Works with no AI provider; distinguishes dollar, token and 'worth of' amount forms." },
  { status: "built", title: "Live Uniswap V3 routing and quoting", detail: "Exact-output and exact-input, every fee tier quoted, honest route_unavailable on failure." },
  { status: "built", title: "Token discovery by symbol, name or address", detail: "Real Monad chain state; metadata re-read from the contract before it can be spent." },
  { status: "built", title: "Token state and risk models", detail: "UNKNOWN → DISCOVERED → priced → routable → PAYABLE, plus measurable execution-risk checks." },
  { status: "built", title: "Deterministic source selection", detail: "Balances + ranked options → one source with a human reason and explicit failure codes." },
  { status: "built", title: "Protected plan construction", detail: "Every swap step carries a real on-chain output bound." },
  { status: "built", title: "Signing guard", detail: "Rebuilds everything from fresh data immediately before signing; refuses on any change." },
  { status: "built", title: "Delivery verification", detail: "Proves the recipient's transfer from the confirmed receipt; never reports unverified as success." },
  { status: "built", title: "Partial-balance split", detail: "Sends what you hold and converts the shortfall, each leg with its own bound." },
  { status: "progress", title: "Expanding live-network verification", detail: "Broadening opt-in live tests for routing and execution paths." },
  { status: "progress", title: "Copy and error-surface refinement", detail: "Clearer, more actionable messages for every failure mode." },
  { status: "progress", title: "Mobile layout hardening", detail: "Small-screen usability across the composer, review and token search." },
  { status: "planned", title: "Transparent service fee", detail: "Collection plus on-screen disclosure before authorization. Not operational today." },
  { status: "planned", title: "Richer route comparison", detail: "Where additional quote sources become available." },
  { status: "planned", title: "Accessibility work", detail: "Continued keyboard and assistive-technology improvements." },
];

export default function Roadmap() {
  return (
    <DocsShell>
      <DocTitle
        eyebrow="Roadmap"
        title="Built, in progress, planned"
        intro="This roadmap reflects the repository. It carries no promised dates, no invented commitments, and no partnerships."
      />

      <div className="space-y-2">
        {ITEMS.map((it) => {
          const s = STATUS[it.status];
          return (
            <div key={it.title} className={`rounded-2xl border p-4 ${s.tone}`}>
              <div className="flex items-baseline gap-3">
                <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${s.badge}`}>
                  {s.label}
                </span>
                <span className="text-sm font-medium text-white/85">{it.title}</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-white/50">{it.detail}</p>
            </div>
          );
        })}
      </div>

      <DocSection title="Explicitly out of scope">
        <UL>
          <LI>Reintroducing speculative gas-abstraction paths that cannot be demonstrated end-to-end.</LI>
          <LI>Cross-chain delivery. Intent Pay is Monad-only and is not a bridge.</LI>
          <LI>Claiming MEV-protected submission while no dapp-controllable private path exists on Monad.</LI>
        </UL>
        <P>
          Items are only moved to &ldquo;Built&rdquo; when they are implemented and, where the repository can
          demonstrate it, covered by tests.
        </P>
      </DocSection>
    </DocsShell>
  );
}
