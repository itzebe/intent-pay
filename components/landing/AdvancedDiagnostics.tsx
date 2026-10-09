"use client";

import { useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";
import { useCapabilities } from "@/lib/hooks/useCapabilities";
import { IntegrationStack } from "./IntegrationStack";

/**
 * Collapsed technical surface. Provider names, RPC/paymaster diagnostics and
 * raw errors belong here — never in the primary payment flow, which speaks only
 * in terms of PAY WITH, amount, fee and readiness. Nothing here is hidden from
 * users who want it; it is simply not front-and-centre.
 */
export function AdvancedDiagnostics({ network }: { network: MonadNetwork }) {
  const [open, setOpen] = useState(false);
  const caps = useCapabilities(network);
  const gp = caps?.gasPayment;

  const rows: { label: string; value: string; warn?: boolean }[] = [];
  if (caps && !caps.unavailable) {
    rows.push(
      { label: "routing provider", value: caps.routing?.provider ?? "—" },
      { label: "rpc source", value: caps.gas?.rpc ?? "—" },
      { label: "ERC-20 gas provider", value: gp?.provider ?? "not configured" },
      { label: "ERC-20 gas available", value: gp ? (gp.available ? "yes" : "no") : "—" },
      {
        label: "supported gas tokens",
        value: gp?.supportedTokens?.length
          ? gp.supportedTokens.map((t) => `${t.symbol} (${t.address})`).join(", ")
          : "none accepted",
      },
      {
        label: "wallet abstraction",
        value: caps.walletAbstraction
          ? caps.walletAbstraction.available
            ? "available"
            : `unavailable — ${caps.walletAbstraction.reason ?? "unknown reason"}`
          : "—",
        warn: caps.walletAbstraction ? !caps.walletAbstraction.available : false,
      },
      {
        label: "gas policy",
        value: caps.gas?.policyId
          ? `${caps.gas.policyId} (${caps.gas.policyStatus ?? "unknown"})`
          : "none configured",
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
    if (gp?.error) rows.push({ label: "ERC-20 gas error", value: gp.error, warn: true });
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
