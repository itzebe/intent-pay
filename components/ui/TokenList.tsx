"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenConfig } from "@/lib/config/tokens";
import type { Balance } from "@/lib/domain/intent";
import type { AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { formatUsd, isEvmAddress, shortAddress } from "@/lib/format";
import { TokenBadge } from "./TokenBadge";
import { Check, Spinner, Warning } from "./Icons";
import { resolveAddress } from "@/lib/hooks/useTokenCatalog";

export type PickableToken = TokenConfig & { routable?: boolean | null };

type PasteState =
  | { status: "idle" }
  | { status: "loading"; address: string }
  | { status: "found"; address: string; token: TokenConfig; routable: boolean | null; listed: boolean }
  | { status: "error"; address: string; message: string };

/**
 * Searchable token picker.
 *
 * Availability is data-driven and *honest*:
 *  - the list is the runtime discovery catalog (seed + official Monad list),
 *  - any contract address can be pasted and is resolved against the chain,
 *  - "payable" is only claimed when the routing layer actually probed the
 *    token; an unprobed token is shown as "unknown", never as unsupported.
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
  availability?: Record<string, boolean | null>;
  showBalances?: boolean;
  mode?: AppMode;
  network?: MonadNetwork;
  onAddToken?: (token: TokenConfig) => void;
  /** "pay" hides tokens known to have no route; "receive" shows everything. */
  prefer?: "any" | "pay" | "receive";
}) {
  const [q, setQ] = useState("");
  const [paste, setPaste] = useState<PasteState>({ status: "idle" });
  const [extra, setExtra] = useState<TokenConfig[]>([]);
  const onAddTokenRef = useRef(onAddToken);
  onAddTokenRef.current = onAddToken;

  const query = q.trim();
  const isAddress = isEvmAddress(query);

  const all = useMemo(() => {
    const byAddress = new Map<string, TokenConfig>();
    for (const t of [...tokens, ...extra]) byAddress.set(t.address.toLowerCase(), t);
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

  /** Tri-state routability: undefined = unknown (not probed). */
  const routabilityOf = (t: TokenConfig): boolean | null => {
    if (availability && t.symbol in availability) return availability[t.symbol];
    const r = (t as PickableToken).routable;
    return typeof r === "boolean" ? r : null;
  };

  // Resolve a pasted address against the chain (auto, after a short pause).
  useEffect(() => {
    if (!isAddress) {
      setPaste({ status: "idle" });
      return;
    }
    let cancelled = false;
    setPaste({ status: "loading", address: query });
    const timer = setTimeout(async () => {
      try {
        const res = await resolveAddress(query, mode, network);
        if (cancelled) return;
        if (!res.ok || !res.found || !res.token) {
          setPaste({
            status: "error",
            address: query,
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
        onAddTokenRef.current?.(token);
        setPaste({
          status: "found",
          address: query,
          token,
          routable: res.routable ?? null,
          listed: Boolean(res.listed),
        });
      } catch {
        if (!cancelled)
          setPaste({ status: "error", address: query, message: "Couldn't resolve that address." });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isAddress, mode, network]);

  const unknownMetadata = (t: TokenConfig) =>
    !t.symbol || t.symbol === "Unknown" || t.name === "Unknown token";

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

      {/* Resolving a pasted address — TOKEN FOUND / metadata / route state */}
      {paste.status === "loading" && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-white/60">
          <Spinner className="h-3.5 w-3.5 animate-spin" /> Reading token metadata from Monad…
        </div>
      )}
      {paste.status === "found" && (
        <div className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200/90">
              Token found
            </span>
            {!paste.listed && (
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/50">
                unlisted
              </span>
            )}
          </div>
          <div className="mt-1.5 text-sm text-white/85">
            {paste.token.name}{" "}
            <span className="text-white/45">({paste.token.symbol})</span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] text-white/35">
            {shortAddress(paste.token.address, 6)}
          </div>
          <RouteState routable={paste.routable} />
        </div>
      )}
      {paste.status === "error" && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-100/90">
          <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{paste.message}</span>
        </div>
      )}

      <div className="max-h-[46vh] space-y-1 overflow-y-auto pr-1">
        {filtered.map((t) => {
          const bal = balanceFor(t.symbol);
          const isSelected = selected?.toLowerCase() === t.symbol.toLowerCase();
          const routable = routabilityOf(t);
          // Only hide tokens we *know* are unpayable. Unknown stays selectable
          // so the real quote can decide.
          const unavailable = prefer === "pay" && routable === false;
          const unknown = unknownMetadata(t);
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
                  <span className="text-sm font-semibold text-white">
                    {unknown ? "Unknown token" : t.symbol}
                  </span>
                  {!t.seed && !unknown && (
                    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/45">
                      {t.source === "onchain" ? "imported" : "listed"}
                    </span>
                  )}
                  {routable === false && (
                    <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-200/80">
                      no route
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-white/40">
                  {unknown ? shortAddress(t.address, 6) : t.name}
                </div>
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

/** The dynamic receive-token route state, kept honest about what we know. */
function RouteState({ routable }: { routable: boolean | null }) {
  if (routable === true) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-emerald-200/90">
        <Check className="h-3.5 w-3.5" /> Ready to pay · a usable route exists
      </div>
    );
  }
  if (routable === false) {
    return (
      <div className="mt-2 text-[11px] text-amber-200/80">
        This token exists on Monad, but no usable payment route is currently available.
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/45">
      <Spinner className="h-3 w-3 animate-spin" /> Checking payment route… select to price it
    </div>
  );
}
