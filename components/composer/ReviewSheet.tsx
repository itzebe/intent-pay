"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Quote } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import { formatAmount, formatGasUsd, formatUsd, shortAddress, usdTokenLabel } from "@/lib/format";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { ArrowDown, ChevronDown, Shield, Warning } from "@/components/ui/Icons";

/**
 * Pre-execution confirmation. The recipient amount is visually dominant;
 * technical detail lives behind "View transaction details".
 */
export function ReviewSheet({
  quote,
  payToken,
  receiveToken,
  recipient,
  planSteps,
  onConfirm,
  onBack,
  confirming,
  error,
  networkLabel,
}: {
  quote: Quote;
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  recipient: string;
  planSteps: string[];
  onConfirm: () => void;
  onBack: () => void;
  confirming: boolean;
  error?: string | null;
  networkLabel: string;
}) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-5 pb-4 pt-5 sm:px-6">
        <p className="text-center text-xs font-medium uppercase tracking-[0.14em] text-white/40">
          Review payment
        </p>

        <div className="mt-4 text-center">
          <div className="mb-3 flex justify-center">
            <TokenBadge token={receiveToken} size={56} />
          </div>
          <h2 className="num text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            You are sending {usdTokenLabel(quote.receiveUsd, receiveToken.symbol)}
          </h2>
          <p className="mt-1.5 text-sm text-white/45">
            to <span className="font-mono text-white/70">{shortAddress(recipient, 6)}</span>
          </p>
        </div>

        <div className="mt-6 space-y-2.5 rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4">
          <SummaryRow label="Recipient" value={shortAddress(recipient, 6)} mono />
          <SummaryRow label="You pay" value={usdTokenLabel(quote.payUsd, payToken.symbol)} sub={`${formatAmount(quote.payAmount)} ${payToken.symbol}`} />
          <SummaryRow
            label="Recipient receives"
            value={usdTokenLabel(quote.receiveUsd, receiveToken.symbol)}
            sub={`${formatAmount(quote.receiveAmount)} ${receiveToken.symbol}`}
            strong
          />
          <SummaryRow label="Conversion" value={quote.route.path.join(" → ")} mono />
          <SummaryRow label="Network" value={networkLabel} />
          <SummaryRow label="Estimated network cost" value={formatGasUsd(quote.networkCostUsd)} />
          <div className="hairline mt-1 pt-3">
            <SummaryRow label="Total sender cost" value={formatUsd(quote.totalSenderCostUsd)} strong />
          </div>
        </div>

        <button
          onClick={() => setShowDetails((d) => !d)}
          className="mt-4 flex w-full items-center justify-between rounded-xl px-2 py-2 text-sm text-white/55 transition hover:bg-white/[0.04] hover:text-white/85"
        >
          <span>View transaction details</span>
          <ChevronDown className={`h-4 w-4 transition-transform ${showDetails ? "rotate-180" : ""}`} />
        </button>

        <AnimatePresence>
          {showDetails && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 rounded-2xl border border-white/[0.06] bg-ink-900/60 p-4 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-white/40">Routing provider</span>
                  <span className="font-mono text-white/70">
                    {quote.mode === "demo" ? "Simulated · Demo mode" : "Uniswap V3 · Monad"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/40">Slippage protection</span>
                  <span className="font-mono text-white/70">
                    {quote.exactOutput ? "Exact output" : "Exact input"}
                  </span>
                </div>
                <div className="hairline my-1" />
                <p className="text-white/40">Steps your wallet will sign</p>
                <ol className="mt-1 space-y-1.5">
                  {planSteps.map((s, i) => (
                    <li key={i} className="flex gap-2 text-white/70">
                      <span className="num text-white/35">{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
                {quote.mode === "demo" && (
                  <p className="mt-2 rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200/90">
                    Demo mode — this confirms the experience only. No blockchain transaction is sent.
                  </p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 text-xs text-white/50">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300/70" />
          <span>
            You&apos;ll be asked to approve each step in your wallet. The payment only succeeds when the
            recipient receives the amount above.
          </span>
        </div>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-3 flex items-start gap-2 rounded-2xl border border-red-400/25 bg-red-500/[0.08] p-3 text-xs text-red-200"
            >
              <Warning className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-ink-850/90 px-5 py-4 backdrop-blur-xl sm:px-6">
        <div className="flex gap-2.5">
          <button onClick={onBack} className="btn-ghost px-4" disabled={confirming}>
            Back
          </button>
          <button onClick={onConfirm} className="btn-primary flex-1" disabled={confirming}>
            {confirming ? "Sending…" : `Confirm & Send ${usdTokenLabel(quote.receiveUsd, receiveToken.symbol)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  sub,
  strong,
  mono,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white/45">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        <span className={`num ${strong ? "text-sm font-semibold text-white" : "text-sm text-white/85"} ${mono ? "font-mono text-[12px]" : ""}`}>
          {value}
        </span>
        {sub && <span className="num text-[11px] text-white/35">{sub}</span>}
      </span>
    </div>
  );
}

/** Small reusable step list for the execution progress overlay. */
export function StepProgress({
  steps,
}: {
  steps: { label: string; status: string }[];
}) {
  return (
    <ul className="space-y-2">
      {steps.map((s) => (
        <li key={s.label} className="flex items-center gap-2 text-xs">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              s.status === "confirmed"
                ? "bg-emerald-400"
                : s.status === "failed"
                  ? "bg-red-400"
                  : s.status === "submitted"
                    ? "bg-mono-soft"
                    : "bg-white/25"
            }`}
          />
          <span className="text-white/65">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

export { ArrowDown };
