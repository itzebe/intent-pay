"use client";

import { useState } from "react";
import type { Balance } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import type { MonadNetwork } from "@/lib/config/chains";
import { formatUsd } from "@/lib/format";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { ChevronDown, Sparkle } from "@/components/ui/Icons";
import { Modal } from "@/components/ui/Modal";
import { TokenList } from "@/components/ui/TokenList";
import type { OptimizeResult } from "@/lib/hooks/useOptimizer";

/**
 * Step 3 — how will I pay?
 * Recommends the best available asset, but lets advanced users expand and
 * choose any funded asset. Any token can also be imported by address.
 *
 * When the optimizer has ranked the wallet's assets, each chip shows what it
 * would actually cost and whether it can pay — so "best" is a real answer, not
 * just the largest balance.
 */
export function PayAssetPicker({
  balances,
  selected,
  recommended,
  payTokenIsSet = true,
  onSelect,
  availability,
  catalog,
  network,
  onAddToken,
  optimizer,
  optimizerLoading,
}: {
  balances: Balance[];
  selected: string;
  recommended: string | null;
  /** False while the source is only an optimizer suggestion, not a choice. */
  payTokenIsSet?: boolean;
  /** The exact contract address is passed so identity is never symbol-only. */
  onSelect: (symbol: string, address?: string) => void;
  availability?: Record<string, boolean | null>;
  catalog: TokenConfig[];
  network: MonadNetwork;
  onAddToken?: (token: TokenConfig) => void;
  optimizer?: OptimizeResult | null;
  optimizerLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const funded = balances.filter((b) => b.usd > 0);

  const selectedBalance = balances.find((b) => b.token.symbol === selected);
  const optionFor = (symbol: string) =>
    optimizer?.options.find((o) => o.symbol === symbol);
  const bestSymbol = optimizer?.best?.symbol ?? recommended;
  // A recommendation is not a selection: don't render the suggested asset as
  // already chosen until the user actually picks one.
  const activeSelection = payTokenIsSet ? selected : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label">How will you pay?</span>
        <span className="text-[11px] text-white/35">
          Your wallet · {formatUsd(balances.reduce((s, b) => s + b.usd, 0))}
        </span>
      </div>

      {!payTokenIsSet && (
        <p className="mb-2 text-xs text-white/45">
          Choose the asset you want to pay with.
        </p>
      )}

      <div className="rounded-2xl border border-white/[0.08] bg-ink-900/50 p-3">
        {funded.length === 0 ? (
          <div className="px-1 py-2 text-sm text-white/45">
            No supported balances found in this wallet.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {funded.map((b) => {
              const isSelected = b.token.symbol === activeSelection;
              const isRecommended = b.token.symbol === bestSymbol && !isSelected;
              const opt = optionFor(b.token.symbol);
              const unusable = opt && !opt.ok;
              const insufficient = opt && opt.ok && !opt.sufficient;
              const sub = opt?.ok
                ? insufficient
                  ? `Need ${formatUsd(opt.payUsd ?? 0)}`
                  : `Pay ~${formatUsd(opt.payUsd ?? 0)}`
                : formatUsd(b.usd);
              return (
                <button
                  key={b.token.symbol}
                  onClick={() => onSelect(b.token.symbol, b.token.address)}
                  disabled={Boolean(unusable)}
                  className={`group relative flex items-center gap-2 rounded-2xl border py-2 pl-2 pr-3 text-left transition ${
                    isSelected
                      ? "border-mono/60 bg-mono/15"
                      : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"
                  } ${unusable ? "cursor-not-allowed opacity-50" : ""}`}
                  title={unusable ? opt?.reason : undefined}
                >
                  <TokenBadge token={b.token} size={28} />
                  <span className="leading-tight">
                    <span className="block text-sm font-semibold text-white">{b.token.symbol}</span>
                    <span
                      className={`num block text-[11px] ${
                        insufficient ? "text-amber-300/80" : "text-white/45"
                      }`}
                    >
                      {sub}
                    </span>
                  </span>
                  {isRecommended && (
                    <span className="absolute -right-1 -top-2 inline-flex items-center gap-1 rounded-full bg-mono px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow">
                      <Sparkle className="h-2.5 w-2.5" /> Best
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {optimizerLoading && (
          <p className="mt-2 px-1 text-[11px] text-white/35">Finding the best way to pay…</p>
        )}

        <button
          onClick={() => setOpen(true)}
          className="mt-3 flex w-full items-center justify-between rounded-xl px-2 py-2 text-sm text-white/55 transition hover:bg-white/[0.04] hover:text-white/80"
        >
          <span>Choose another asset</span>
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {activeSelection && selectedBalance && selectedBalance.usd === 0 && (
        <p className="mt-2 text-xs text-amber-300/80">
          You don&apos;t hold any {activeSelection}. Pick a funded asset above.
        </p>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Pay with">
        <TokenList
          tokens={catalog}
          balances={balances}
          selected={selected}
          availability={availability}
          network={network}
          onAddToken={onAddToken}
          prefer="pay"
          onSelect={(s, address) => {
            onSelect(s, address);
            setOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}
