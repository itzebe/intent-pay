"use client";

import { useCapabilities } from "@/lib/hooks/useCapabilities";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * Honest ecosystem strip.
 *
 * Lists the real infrastructure behind Intent Pay and whether each piece is
 * actually configured right now. A provider that isn't configured is shown as
 * inactive rather than hidden or overclaimed.
 */
type Item = {
  name: string;
  role: string;
  active: boolean;
  detail: string;
};

export function IntegrationStack({ network }: { network: MonadNetwork }) {
  const caps = useCapabilities(network);
  if (!caps) return null;

  const items: Item[] = [
    {
      name: "Uniswap V3",
      role: "Routing",
      active: true,
      detail: "Live exact-output routes on Monad",
    },
    {
      name: "Alchemy",
      role: "RPC · Gas",
      active: caps.gas.alchemy,
      detail: caps.gas.sponsorshipConfigured
        ? "RPC + gas sponsorship ready"
        : caps.gas.alchemy
          ? "RPC transport"
          : "Add an API key to enable",
    },
    {
      name: "Zerion",
      role: "Wallet intelligence",
      active: caps.wallet.zerion,
      detail: caps.wallet.zerion ? "Discovering wallet assets" : "Add an API key to enable",
    },
    {
      name: caps.pricing.primary ? "Alchemy Prices" : "GeckoTerminal · DexScreener",
      role: "Market prices",
      active: true,
      detail: "Live USD pricing for Monad tokens",
    },
  ];

  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.name}
          className="rounded-2xl border border-white/[0.06] bg-ink-900/40 px-3.5 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-white">{it.name}</span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                it.active
                  ? "bg-emerald-400/10 text-emerald-200/90"
                  : "bg-white/[0.05] text-white/40"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  it.active ? "bg-emerald-400" : "bg-white/30"
                }`}
              />
              {it.active ? "Active" : "Off"}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-white/30">
            {it.role}
          </div>
          <div className="mt-1.5 text-[11px] leading-snug text-white/45">{it.detail}</div>
        </div>
      ))}
    </div>
  );
}
