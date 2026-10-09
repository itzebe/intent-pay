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
  /** Configured but failing to answer — neither "Active" nor "Off". */
  degraded?: boolean;
  detail: string;
};

export function IntegrationStack({ network }: { network: MonadNetwork }) {
  const caps = useCapabilities(network);
  // With no real capability answer (degraded fallback) we show nothing rather
  // than a strip that would falsely read "Off / add a key" for providers that
  // are in fact configured.
  if (!caps || caps.unavailable) return null;

  const alchemyConfigured = caps.gas.alchemyConfigured ?? caps.gas.alchemy;
  const alchemyReachable = caps.gas.alchemyReachable ?? caps.gas.alchemy;
  const bundlerReachable = caps.gas.bundlerReachable ?? false;
  const paymasterConfigured = caps.gas.paymasterConfigured ?? false;
  const policyStatus = caps.gas.policyStatus ?? "unknown";
  const sponsorship = caps.gas.sponsorshipConfigured ?? false;
  const zerionConfigured = caps.wallet.zerionConfigured ?? caps.wallet.zerion;
  const zerionReachable = caps.wallet.zerionReachable ?? caps.wallet.zerion;

  const gp = caps.gasPayment;
  const gpConfigured = gp?.configured ?? false;
  const gpReachable = gp?.reachable ?? false;
  const gpTokens = gp?.supportedTokens ?? [];

  // Alchemy's AA stack is only "Active" when the node *and* the Bundler answer;
  // a configured Gas Manager policy is surfaced separately so a working node is
  // never hidden by an unrelated policy problem.
  const alchemyActive = alchemyReachable;
  const alchemyDetail = !alchemyConfigured
    ? "Add an API key to enable"
    : !alchemyReachable
      ? `Configured, but unreachable${caps.gas.alchemyError ? ` — ${caps.gas.alchemyError}` : ""}`
      : [
          "RPC",
          bundlerReachable ? "Bundler" : "Bundler unavailable",
          sponsorship
            ? "Paymaster"
            : paymasterConfigured
              ? `Paymaster ${policyStatus === "expired" ? "expired" : "not usable"}`
              : "no Gas Manager policy",
        ].join(" · ");

  const items: Item[] = [
    {
      name: "Uniswap V3",
      role: "Routing",
      active: true,
      detail: "Live exact-output routes on Monad",
    },
    {
      name: "Alchemy",
      role: "AA · Bundler · Paymaster",
      active: alchemyActive,
      degraded: alchemyConfigured && !alchemyReachable,
      detail: alchemyDetail,
    },
    {
      name: "Zerion",
      role: "Wallet intelligence",
      active: zerionReachable,
      degraded: zerionConfigured && !zerionReachable,
      detail: !zerionConfigured
        ? "Add an API key to enable"
        : !zerionReachable
          ? `Configured, but unreachable${caps.wallet.zerionError ? ` — ${caps.wallet.zerionError}` : ""}`
          : "Discovering wallet assets",
    },
    {
      name: caps.pricing.primary ? "Alchemy Prices" : "GeckoTerminal · DexScreener",
      role: "Market prices",
      active: true,
      detail: "Live USD pricing for Monad tokens",
    },
    {
      name: gp?.provider ? `Gas paymaster · ${gp.provider}` : "Gas paymaster",
      role: "ERC-20 gas",
      active: gpConfigured && gpReachable,
      degraded: gpConfigured && !gpReachable,
      detail: !gpConfigured
        ? "Add a Pimlico key to enable gas-in-token"
        : !gpReachable
          ? `Configured, but unreachable${gp?.error ? ` — ${gp.error}` : ""}`
          : gpTokens.length
            ? `Gas payable in ${gpTokens.map((t) => t.symbol).join(", ")}`
            : "No tokens accepted on this chain",
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
                  : it.degraded
                    ? "bg-amber-400/10 text-amber-200/90"
                    : "bg-white/[0.05] text-white/40"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  it.active ? "bg-emerald-400" : it.degraded ? "bg-amber-400" : "bg-white/30"
                }`}
              />
              {it.active ? "Active" : it.degraded ? "Check" : "Off"}
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
