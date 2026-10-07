"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { Quote } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import { formatAmount, formatGasUsd, formatImpact, formatUsd, usdTokenLabel } from "@/lib/format";
import { Spinner, Warning } from "@/components/ui/Icons";
import type { QuoteError } from "@/lib/hooks/usePayment";

/** Live calculation readout. Updates on every intent change. */
export function LiveCalculation({
  quote,
  quoting,
  error,
  payToken,
  receiveToken,
  onUseAlternative,
}: {
  quote: Quote | null;
  quoting: boolean;
  error: QuoteError | null;
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  onUseAlternative?: (symbol: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="label">Live calculation</span>
        <AnimatePresence>
          {quoting && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="inline-flex items-center gap-1.5 text-[11px] text-white/45"
            >
              <Spinner className="h-3.5 w-3.5 animate-spin" /> Pricing…
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence mode="wait">
        {error ? (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-3"
          >
            <div className="flex items-start gap-2">
              <Warning className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <div>
                <p className="text-sm font-semibold text-amber-100">
                  {error.code === "route_unavailable" ? "Route unavailable" : "Can't price this yet"}
                </p>
                <p className="mt-0.5 text-xs text-white/60">{error.message}</p>
                {error.code === "route_unavailable" && error.alternatives?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {error.alternatives
                      .filter((s) => s !== receiveToken.symbol)
                      .slice(0, 5)
                      .map((s) => (
                        <button
                          key={s}
                          onClick={() => onUseAlternative?.(s)}
                          className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:border-white/25"
                        >
                          {s}
                        </button>
                      ))}
                  </div>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : quote ? (
          <motion.div
            key="quote"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-2.5"
          >
            <Row label="You pay" value={usdTokenLabel(quote.payUsd, payToken.symbol)} usd={`${formatAmount(quote.payAmount)} ${payToken.symbol}`} />
            <Row label="Recipient receives" value={usdTokenLabel(quote.receiveUsd, receiveToken.symbol)} usd={`${formatAmount(quote.receiveAmount)} ${receiveToken.symbol}`} strong />
            <Row label="Conversion" value={quote.route.path.join(" → ")} mono />
            {formatImpact(quote.priceImpact) && (
              <Row label="Price impact" value={formatImpact(quote.priceImpact)!} />
            )}
            <div className="hairline pt-2.5">
              <Row
                label="Estimated network cost"
                value={
                  quote.networkCostUsdAvailable === false
                    ? "Unavailable"
                    : formatGasUsd(quote.networkCostUsd)
                }
              />
              <Row
                label="Total sender cost"
                value={
                  quote.networkCostUsdAvailable === false
                    ? `≥ ${formatUsd(quote.totalSenderCostUsd)} + gas`
                    : formatUsd(quote.totalSenderCostUsd)
                }
              />
            </div>
            <p className="pt-1 text-[10px] uppercase tracking-wider text-white/30">
              {priceProvenance(quote)}
            </p>
          </motion.div>
        ) : (
          <motion.p
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="py-3 text-center text-sm text-white/35"
          >
            Enter a valid recipient and amount to see the payment.
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Plain-language label for where the live prices came from. */
function priceProvenance(quote: Quote): string {
  if (quote.receivePriceUnavailable) return "Recipient token price unavailable";
  const kind = (s?: string) =>
    s === "stable" ? "stablecoin peg"
      : s === "market" ? "market price"
        : s === "dex" ? "DEX price"
          : s === "onchain" ? "on-chain price"
            : "reference price";
  return `Priced at ${kind(quote.receivePriceSource)}`;
}

function Row({
  label,
  value,
  usd,
  strong,
  mono,
}: {
  label: string;
  value: string;
  usd?: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white/45">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        <span
          className={`num ${strong ? "text-sm font-semibold text-white" : "text-sm text-white/85"} ${
            mono ? "font-mono text-[12px]" : ""
          }`}
        >
          {value}
        </span>
        {usd && <span className="num text-[11px] text-white/35">{usd}</span>}
      </span>
    </div>
  );
}
