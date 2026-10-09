"use client";

import { useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { IntegrationStack } from "./IntegrationStack";

/**
 * Collapsed technical surface. Provider names, RPC diagnostics and raw errors
 * belong here — never in the primary payment flow, which speaks only in terms
 * of PAY WITH, amount, fee and readiness. Nothing here is hidden from users who
 * want it; it is simply not front-and-centre.
 */
export function AdvancedDiagnostics({ network }: { network: MonadNetwork }) {
  const [open, setOpen] = useState(false);
  const caps = useCapabilities(network);

  const rows: { label: string; value: string; warn?: boolean }[] = [];
  if (caps && !caps.unavailable) {
    rows.push(
      { label: "routing provider", value: caps.routing?.provider ?? "—" },
      { label: "rpc source", value: caps.gas?.rpc ?? "—" },
      { label: "alchemy", value: caps.gas?.alchemyReachable ? "reachable" : caps.gas?.alchemyConfigured ? "configured, unreachable" : "not configured" },
      {
        label: "market prices",
        value: caps.pricing?.primary ?? "fallback chain",
      },
      {
        label: "zerion assets",
        value: caps.wallet?.zerionReachable
          ? "reachable"
          : caps.wallet?.zerionConfigured
            ? `configured, unreachable${caps.wallet.zerionError ? ` — ${caps.wallet.zerionError}` : ""}`
            : "not configured",
        warn: Boolean(caps.wallet?.zerionConfigured && !caps.wallet?.zerionReachable),
      },
    );
    if (caps.gas?.alchemyError)
      rows.push({ label: "alchemy error", value: caps.gas.alchemyError, warn: true });
  }

  return (
    <details
      className="mt-4 rounded-2xl border border-white/[0.06] bg-ink-900/30"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-xs font-medium text-white/50 hover:text-white/70">
        Advanced diagnostics
        <span className="ml-1 text-white/30">{open ? "▾" : "▸"}</span>
      </summary>

      <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">
        <IntegrationStack network={network} />

        {rows.length > 0 && (
          <dl className="mt-3 grid grid-cols-1 gap-1 font-mono text-[10px] leading-relaxed sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.label} className={r.warn ? "text-amber-200/60" : "text-white/35"}>
                <dt className="inline text-white/25">{r.label}: </dt>
                <dd className="inline break-all">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </details>
  );
}
