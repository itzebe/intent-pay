"use client";

import { useState } from "react";
import { shortAddress } from "@/lib/format";
import { Bolt, ChevronDown, Wallet } from "@/components/ui/Icons";

/** Connect / connected pill. One tap, obvious, wallet-first. */
export function ConnectButton({
  status,
  address,
  hasProvider,
  onConnect,
  onDisconnect,
}: {
  status: "disconnected" | "connecting" | "connected";
  address?: string;
  hasProvider: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (status === "connected" && address) {
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-2 pl-2.5 pr-3 transition hover:border-white/20"
        >
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_2px_rgba(52,211,153,0.6)]" />
          <span className="num font-mono text-xs text-white/85">{shortAddress(address)}</span>
          <ChevronDown className="h-3.5 w-3.5 text-white/45" />
        </button>
        {open && (
          <div className="absolute right-0 top-12 z-30 w-52 overflow-hidden rounded-2xl border border-white/10 bg-ink-800/95 p-1.5 shadow-2xl backdrop-blur-xl">
            <div className="px-3 py-2">
              <div className="label">Connected</div>
              <div className="num mt-0.5 font-mono text-xs text-white/70">{shortAddress(address, 6)}</div>
            </div>
            <button
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-white/75 transition hover:bg-white/[0.06]"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      onClick={onConnect}
      disabled={status === "connecting"}
      className="btn-primary py-2.5 text-sm"
    >
      {status === "connecting" ? (
        "Connecting…"
      ) : (
        <>
          <Wallet className="h-4 w-4" />
          {hasProvider ? "Connect wallet" : "Connect wallet"}
        </>
      )}
    </button>
  );
}

/** Compact balance overview — deliberately not a wallet dashboard. */
export function BalanceOverview({
  balances,
  loading,
  demo,
}: {
  balances: { token: { symbol: string; tint: string }; amount: string; usd: number }[];
  loading?: boolean;
  demo?: boolean;
}) {
  const total = balances.reduce((s, b) => s + b.usd, 0);
  const funded = balances.filter((b) => b.usd > 0);

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4">
      <div className="flex items-center justify-between">
        <span className="label">Your wallet</span>
        <span className="num text-sm font-semibold text-white">
          ${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {loading ? (
          <span className="text-xs text-white/40">Reading balances…</span>
        ) : funded.length === 0 ? (
          <span className="text-xs text-white/40">No supported balances</span>
        ) : (
          funded.map((b) => (
            <span key={b.token.symbol} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: b.token.tint }} />
              <span className="text-xs text-white/55">{b.token.symbol}</span>
              <span className="num text-xs font-medium text-white/85">
                ${b.usd.toFixed(2)}
              </span>
            </span>
          ))
        )}
      </div>
      {demo && (
        <div className="mt-3 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/30">
          <Bolt className="h-3 w-3" /> Sample wallet · demo mode
        </div>
      )}
    </div>
  );
}
