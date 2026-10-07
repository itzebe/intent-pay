"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { Quote } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import { formatAmount, formatGasUsd, formatImpact } from "@/lib/format";
import { planEconomics } from "@/lib/execution/plan";
import { Spinner, Warning } from "@/components/ui/Icons";
import type { QuoteError } from "@/lib/hooks/usePayment";
import type { Readiness } from "@/lib/domain/readiness";

/**
 * Compact payment details.
 *
 * The flow itself (Pay with → Recipient gets) is shown above; this card only
 * carries the handful of facts a payer needs: rate, route (only when a
 * conversion is required), network fee, and the guaranteed minimum.
 */
export function LiveCalculation({
  quote,
  quoting,
  error,
  payToken,
  receiveToken,
  readiness,
  onUseAlternative,
}: {
  quote: Quote | null;
  quoting: boolean;
  error: QuoteError | null;
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  readiness?: Readiness;
  onUseAlternative?: (symbol: string) => void;
}) {
  const econ = quote ? planEconomics(quote) : null;
  const isConversion = Boolean(quote) && quote!.route.kind === "swap";
  const rate =
    quote && quote.rate > 0
      ? `1 ${payToken.symbol} ≈ ${formatAmount(String(quote.rate))} ${receiveToken.symbol}`
      : null;

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="label">Details</span>
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
                {/* A specific, actionable headline — never a bare "Route unavailable". */}
                <p className="text-sm font-semibold text-amber-100">
                  {readiness && !readiness.ready ? readiness.cta : "Can't price this yet"}
                </p>
                <p className="mt-0.5 text-xs text-white/60">
                  {readiness?.message ?? error.message}
                </p>
                {error.code === "route_unavailable" && error.alternatives?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {error.alternatives
                      .filter((s) => s !== receiveToken.symbol && s !== payToken.symbol)
                      .slice(0, 5)
                      .map((s) => (
                        <button
                          key={s}
                          onClick={() => onUseAlternative?.(s)}
                          className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/80 transition hover:border-white/25"
                        >
                          Pay with {s}
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
            {rate && <Row label="Rate" value={rate} />}
            {isConversion && (
              <Row label="Route" value={`${quote.route.path.join(" → ")} · Uniswap V3`} mono />
            )}
            {isConversion && formatImpact(quote.priceImpact) && (
              <Row label="Price impact" value={formatImpact(quote.priceImpact)!} />
            )}
            <Row
              label="Network fee"
              value={
                quote.networkCostUsdAvailable === false
                  ? "Unavailable"
                  : formatGasUsd(quote.networkCostUsd)
              }
            />
            {econ && (
              <Row
                label={econ.exact ? "Recipient receives" : "Minimum received"}
                value={`${formatAmount(econ.minimumReceived)} ${receiveToken.symbol}`}
                sub={econ.exact ? "exact output" : `${(econ.slippageBps / 100).toFixed(2)}% slippage`}
              />
            )}
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

function Row({
  label,
  value,
  sub,
  mono,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white/45">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        <span className={`num text-sm text-white/85 ${mono ? "font-mono text-[12px]" : ""}`}>
          {value}
        </span>
        {sub && <span className="num text-[11px] text-white/35">{sub}</span>}
      </span>
    </div>
  );
}
