"use client";

import { useState } from "react";
import type { Balance } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import type { AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { formatUsd } from "@/lib/format";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { ChevronDown, Sparkle } from "@/components/ui/Icons";
import { Modal } from "@/components/ui/Modal";
import { TokenList } from "@/components/ui/TokenList";

/**
 * Step 3 — how will I pay?
 * Recommends the best available asset, but lets advanced users expand and
 * choose any funded asset. Any token can also be imported by address.
 */
export function PayAssetPicker({
  balances,
  selected,
  recommended,
  onSelect,
  availability,
  catalog,
  mode,
  network,
  onAddToken,
}: {
  balances: Balance[];
  selected: string;
  recommended: string | null;
  onSelect: (symbol: string) => void;
  availability?: Record<string, boolean | null>;
  catalog: TokenConfig[];
  mode: AppMode;
  network: MonadNetwork;
  onAddToken?: (token: TokenConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const funded = balances.filter((b) => b.usd > 0);

  const selectedBalance = balances.find((b) => b.token.symbol === selected);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="label">How will you pay?</span>
        <span className="text-[11px] text-white/35">
          Your wallet · {formatUsd(balances.reduce((s, b) => s + b.usd, 0))}
        </span>
      </div>

      <div className="rounded-2xl border border-white/[0.08] bg-ink-900/50 p-3">
        {funded.length === 0 ? (
          <div className="px-1 py-2 text-sm text-white/45">
            No supported balances found in this wallet.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {funded.map((b) => {
              const isSelected = b.token.symbol === selected;
              const isRecommended = b.token.symbol === recommended && !isSelected;
              return (
                <button
                  key={b.token.symbol}
                  onClick={() => onSelect(b.token.symbol)}
                  className={`group relative flex items-center gap-2 rounded-2xl border py-2 pl-2 pr-3 text-left transition ${
                    isSelected
                      ? "border-mono/60 bg-mono/15"
                      : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"
                  }`}
                >
                  <TokenBadge token={b.token} size={28} />
                  <span className="leading-tight">
                    <span className="block text-sm font-semibold text-white">{b.token.symbol}</span>
                    <span className="num block text-[11px] text-white/45">{formatUsd(b.usd)}</span>
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

        <button
          onClick={() => setOpen(true)}
          className="mt-3 flex w-full items-center justify-between rounded-xl px-2 py-2 text-sm text-white/55 transition hover:bg-white/[0.04] hover:text-white/80"
        >
          <span>Choose another asset</span>
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {selectedBalance && selectedBalance.usd === 0 && (
        <p className="mt-2 text-xs text-amber-300/80">
          You don&apos;t hold any {selected}. Pick a funded asset above.
        </p>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Pay with">
        <TokenList
          tokens={catalog}
          balances={balances}
          selected={selected}
          availability={availability}
          mode={mode}
          network={network}
          onAddToken={onAddToken}
          prefer="pay"
          onSelect={(s) => {
            onSelect(s);
            setOpen(false);
          }}
        />
      </Modal>
    </div>
  );
}
