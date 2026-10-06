"use client";

import { useMemo, useState } from "react";
import type { TokenConfig } from "@/lib/config/tokens";
import type { Balance } from "@/lib/domain/intent";
import { formatUsd } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";
import { Check } from "./Icons";

/** Searchable token picker. Availability is data-driven, never hardcoded. */
export function TokenList({
  tokens,
  balances,
  selected,
  onSelect,
  availability,
  showBalances = true,
}: {
  tokens: TokenConfig[];
  balances?: Balance[];
  selected?: string;
  onSelect: (symbol: string) => void;
  availability?: Record<string, boolean>;
  showBalances?: boolean;
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return tokens;
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(needle) ||
        t.name.toLowerCase().includes(needle) ||
        t.address.toLowerCase().includes(needle),
    );
  }, [tokens, q]);

  const balanceFor = (symbol: string) =>
    balances?.find((b) => b.token.symbol === symbol);

  return (
    <div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search tokens"
        className="field mb-3"
      />
      <div className="max-h-[46vh] space-y-1 overflow-y-auto pr-1">
        {filtered.map((t) => {
          const bal = balanceFor(t.symbol);
          const isSelected = selected?.toLowerCase() === t.symbol.toLowerCase();
          const unavailable = availability ? availability[t.symbol] === false : false;
          return (
            <button
              key={t.symbol}
              onClick={() => onSelect(t.symbol)}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${
                isSelected ? "bg-mono/15 ring-1 ring-mono/40" : "hover:bg-white/[0.05]"
              }`}
            >
              <TokenBadge token={t} size={34} dim={unavailable} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{t.symbol}</span>
                  {unavailable && (
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/45">
                      no route
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-white/40">{t.name}</div>
              </div>
              {showBalances && bal && (
                <div className="text-right">
                  <div className="num text-sm text-white/85">{formatUsd(bal.usd)}</div>
                  <div className="num text-[11px] text-white/35">
                    {Number(bal.amount).toLocaleString("en-US", { maximumFractionDigits: 4 })}
                  </div>
                </div>
              )}
              {isSelected && <Check className="h-4 w-4 text-mono-soft" />}
            </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="py-8 text-center text-sm text-white/40">No tokens match “{q}”.</div>
        )}
      </div>
    </div>
  );
}
