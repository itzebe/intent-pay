"use client";

import { useEffect, useMemo, useState } from "react";
import type { TokenConfig } from "@/lib/config/tokens";
import type { Balance } from "@/lib/domain/intent";
import type { AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { formatUsd } from "@/lib/format";
import { isEvmAddress } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";
import { Check, Spinner, Warning } from "./Icons";
import { resolveAddress } from "@/lib/hooks/useTokenCatalog";

export type PickableToken = TokenConfig & { routable?: boolean };

/**
 * Searchable token picker. Availability is data-driven:
 *  - the list comes from the discovery catalog (seed + official Monad list),
 *  - a token can be added by pasting any contract address, which is resolved
 *    against the chain rather than rejected for not being on a list.
 */
export function TokenList({
  tokens,
  balances,
  selected,
  onSelect,
  availability,
  showBalances = true,
  mode = "demo",
  network = "mainnet",
  onAddToken,
  prefer = "any",
}: {
  tokens: TokenConfig[];
  balances?: Balance[];
  selected?: string;
  onSelect: (symbol: string) => void;
  availability?: Record<string, boolean>;
  showBalances?: boolean;
  mode?: AppMode;
  network?: MonadNetwork;
  onAddToken?: (token: TokenConfig) => void;
  /** "pay" hides tokens with no route; "receive" shows everything known. */
  prefer?: "any" | "pay" | "receive";
}) {
  const [q, setQ] = useState("");
  const [paste, setPaste] = useState<{ status: "idle" | "loading" | "error"; message?: string }>({
    status: "idle",
  });
  const [extra, setExtra] = useState<TokenConfig[]>([]);

  const query = q.trim();
  const isAddress = isEvmAddress(query);

  const all = useMemo(() => {
    const byAddress = new Map<string, TokenConfig>();
    for (const t of [...tokens, ...extra]) {
      byAddress.set(t.address.toLowerCase(), t);
    }
    return [...byAddress.values()];
  }, [tokens, extra]);

  const filtered = useMemo(() => {
    if (isAddress) return all.filter((t) => t.address.toLowerCase() === query.toLowerCase());
    const needle = query.toLowerCase();
    if (!needle) return all;
    return all.filter(
      (t) =>
        t.symbol.toLowerCase().includes(needle) ||
        t.name.toLowerCase().includes(needle) ||
        t.address.toLowerCase().includes(needle),
    );
  }, [all, query, isAddress]);

  const balanceFor = (symbol: string) => balances?.find((b) => b.token.symbol === symbol);
  const isRoutable = (t: TokenConfig) => {
    if (availability) return availability[t.symbol] !== false;
    return (t as PickableToken).routable !== false;
  };

  // Resolve a pasted address against the chain (auto, after a short pause).
  useEffect(() => {
    if (!isAddress || !onAddToken) {
      setPaste({ status: "idle" });
      return;
    }
    let cancelled = false;
    setPaste({ status: "loading" });
    const timer = setTimeout(async () => {
      try {
        const res = await resolveAddress(query, mode, network);
        if (cancelled) return;
        if (!res.ok || !res.found || !res.token) {
          setPaste({
            status: "error",
            message: res.problem ?? res.message ?? "No token found at that address.",
          });
          return;
        }
        const token = { ...res.token, routable: res.routable } as TokenConfig;
        setExtra((prev) =>
          prev.some((t) => t.address.toLowerCase() === token.address.toLowerCase())
            ? prev
            : [...prev, token],
        );
        onAddToken(token);
        setPaste({
          status: "idle",
          message: res.routable === false ? "Found, but no route right now" : undefined,
        });
      } catch {
        if (!cancelled) setPaste({ status: "error", message: "Couldn't resolve that address." });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, isAddress, mode, network]);

  return (
    <div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search or paste a Monad token address"
        spellCheck={false}
        autoComplete="off"
        className="field mb-3 font-mono text-[13px]"
      />

      {paste.status === "loading" && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-white/60">
          <Spinner className="h-3.5 w-3.5 animate-spin" /> Reading token metadata from Monad…
        </div>
      )}
      {paste.status === "error" && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-100/90">
          <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{paste.message}</span>
        </div>
      )}
      {paste.status === "idle" && paste.message && (
        <div className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white/60">
          {paste.message}
        </div>
      )}

      <div className="max-h-[46vh] space-y-1 overflow-y-auto pr-1">
        {filtered.map((t) => {
          const bal = balanceFor(t.symbol);
          const isSelected = selected?.toLowerCase() === t.symbol.toLowerCase();
          const routable = isRoutable(t);
          const unavailable = prefer === "pay" && !routable;
          return (
            <button
              key={t.address}
              onClick={() => onSelect(t.symbol)}
              disabled={unavailable}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${
                isSelected ? "bg-mono/15 ring-1 ring-mono/40" : "hover:bg-white/[0.05]"
              } ${unavailable ? "cursor-not-allowed opacity-55" : ""}`}
            >
              <TokenBadge token={t} size={34} dim={unavailable} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-white">{t.symbol}</span>
                  {!t.seed && (
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/45">
                      {t.source === "onchain" ? "imported" : "listed"}
                    </span>
                  )}
                  {unavailable && (
                    <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-200/80">
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

        {filtered.length === 0 && paste.status !== "loading" && (
          <div className="py-8 text-center text-sm text-white/40">
            {isAddress ? (
              "No token found at that address."
            ) : (
              <>
                No tokens match “{q}”.
                <div className="mt-1 text-xs text-white/30">
                  Paste a contract address to import any Monad token.
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
