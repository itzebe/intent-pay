"use client";

import type { TokenConfig } from "@/lib/config/tokens";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { ChevronDown } from "@/components/ui/Icons";

/** "Recipient receives" — the intent field. Large, obvious, token-aware. */
export function AmountField({
  amount,
  onAmountChange,
  token,
  onOpenToken,
  usdHint,
  label = "Recipient receives",
  prefix = "$",
}: {
  amount: string;
  onAmountChange: (v: string) => void;
  token: TokenConfig;
  onOpenToken: () => void;
  usdHint?: string;
  label?: string;
  prefix?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ink-900/60 p-4">
      <div className="label mb-2">{label}</div>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center">
          <span className="num mr-1 text-3xl font-semibold text-white/45">{prefix}</span>
          <input
            value={amount}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              const parts = v.split(".");
              onAmountChange(parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : v);
            }}
            inputMode="decimal"
            placeholder="0.00"
            aria-label={label}
            className="num w-full bg-transparent text-3xl font-semibold text-white outline-none placeholder:text-white/20"
          />
        </div>
        <button
          onClick={onOpenToken}
          className="flex shrink-0 items-center gap-2 rounded-2xl border border-white/[0.09] bg-white/[0.03] py-2 pl-2 pr-3 transition hover:border-white/20 hover:bg-white/[0.06]"
          aria-label="Choose receive token"
        >
          <TokenBadge token={token} size={26} />
          <span className="text-sm font-semibold text-white">{token.symbol}</span>
          <ChevronDown className="h-4 w-4 text-white/50" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-xs text-white/35">
          {usdHint ? usdHint : "Recipient gets exactly this amount"}
        </span>
      </div>
    </div>
  );
}
