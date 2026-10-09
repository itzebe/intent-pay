"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Quote } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import {
  formatAmount,
  formatGasUsd,
  formatImpact,
  formatUsd,
  shortAddress,
  usdTokenLabel,
} from "@/lib/format";
import { planEconomics } from "@/lib/execution/plan";
import type { ExecutionProtection } from "@/lib/domain/protection";
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
  onRetry,
  onRefresh,
  confirming,
  error,
  notice,
  canConfirm = true,
  networkLabel,
  gasMode = "native",
  batchable = false,
  quotedAt,
  quoteStale = false,
  protection,
  partial,
  gasInfo,
  supportedGasTokens,
  onSelectGasToken,
}: {
  quote: Quote;
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  recipient: string;
  planSteps: string[];
  onConfirm: () => void;
  onBack: () => void;
  /** Retry the same review after a recoverable preparation error. */
  onRetry?: () => void;
  /** Force a fresh quote when the displayed one has expired. */
  onRefresh?: () => void;
  confirming: boolean;
  error?: string | null;
  /** A soft, non-blocking notice (e.g. the payment details were updated). */
  notice?: string | null;
  /**
   * Whether Confirm is currently enabled. False while a fresh quote for the
   * current intent is still being fetched, so a stale figure is never signed.
   */
  canConfirm?: boolean;
  networkLabel: string;
  /** How gas will be handled for this payment. */
  gasMode?: "sponsored" | "erc20" | "native";
  /** The connected wallet can submit the plan as one atomic batch. */
  batchable?: boolean;
  /** Unix ms the current quote was produced — shown as a live timestamp. */
  quotedAt?: number;
  /** True when the quote has aged out; the review is then not executable. */
  quoteStale?: boolean;
  /** Honest execution-safety surface (MEV / slippage / price impact). */
  protection?: ExecutionProtection | null;
  /**
   * A partial-balance split: the payment sends what the wallet holds and
   * obtains the shortfall from another funded asset. Null for a normal payment.
   */
  partial?: {
    mode: "direct" | "swap" | "split";
    held: string;
    shortfall: string;
    sourceSymbol: string | null;
  } | null;
  /** Live gas-handling detail: the selected ERC-20 and an honest reason. */
  gasInfo?: {
    mode: "sponsored" | "erc20" | "native";
    erc20GasToken?: { symbol: string; address: string } | null;
    reason?: string | null;
  };
  /** ERC-20 gas tokens the paymaster accepts, with per-wallet status. */
  supportedGasTokens?: {
    address: string;
    symbol: string;
    decimals: number;
    held: boolean;
    sufficientBalance: boolean;
    quoteKnown: boolean;
    estimatedFee: string | null;
    selected: boolean;
  }[];
  /** Choose the ERC-20 that pays the network fee (null = auto / MON). */
  onSelectGasToken?: (address: string | null) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  const impact = formatImpact(quote.priceImpact);
  const econ = planEconomics(quote);
  const quoteTime = quotedAt
    ? new Date(quotedAt).toLocaleTimeString("en-US", { hour12: false })
    : null;

  const erc20GasToken = gasInfo?.erc20GasToken ?? null;
  const viableGasTokens = (supportedGasTokens ?? []).filter(
    (t) => t.held && t.sufficientBalance && t.quoteKnown,
  );

  const gasRow =
    gasMode === "sponsored"
      ? { value: "Sponsored", sub: "by Alchemy" }
      : gasMode === "erc20"
        ? {
            value: `Paid in ${erc20GasToken?.symbol ?? "an ERC-20"}`,
            sub: "no MON required",
          }
        : quote.networkCostUsdAvailable === false
          ? { value: "Unavailable", sub: "no live MON price" }
          : { value: formatGasUsd(quote.networkCostUsd), sub: "paid in MON" };

  // When gas could not be priced from live data the total understates the real
  // cost, so show it as a lower bound rather than a precise figure.
  const totalSenderCost =
    quote.networkCostUsdAvailable === false
      ? `≥ ${formatUsd(quote.totalSenderCostUsd)} + gas`
      : formatUsd(quote.totalSenderCostUsd);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-5 pb-4 pt-5 sm:px-6">
        <p className="text-center text-xs font-medium uppercase tracking-[0.14em] text-white/40">
          Review payment
        </p>

        {quoteStale && (
          <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2 text-xs text-amber-100">
            <div className="flex items-center justify-center gap-2">
              <Warning className="h-4 w-4 shrink-0" />
              <span>This quote expired. Refreshing a live price — confirm again once it updates.</span>
            </div>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={confirming}
                className="btn-ghost mx-auto mt-2 block px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Refresh price
              </button>
            )}
          </div>
        )}

        {notice && (
          <div className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-mono/30 bg-mono/[0.08] px-3 py-2 text-xs text-mono-soft">
            <Warning className="h-4 w-4 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

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
          {impact && <SummaryRow label="Price impact" value={impact} />}
          <SummaryRow
            label={econ.exact ? "Minimum received" : "Guaranteed minimum"}
            value={`${formatAmount(econ.minimumReceived)} ${receiveToken.symbol}`}
            sub={econ.exact ? "exact output" : `${(econ.slippageBps / 100).toFixed(2)}% slippage`}
          />
          <SummaryRow label="Network" value={networkLabel} />
          <SummaryRow
            label="Quote"
            value={quoteTime ? `Live · ${quoteTime}` : "Live"}
            sub={quoteStale ? "stale — refreshing" : "fresh"}
          />
          <SummaryRow
            label="Estimated network cost"
            value={gasRow.value}
            sub={gasRow.sub}
          />
          {viableGasTokens.length > 0 && onSelectGasToken && (
            <div className="pt-1">
              <div className="mb-1.5 text-[11px] text-white/40">
                Pay network fee with
              </div>
              <div className="flex flex-wrap gap-1.5">
                <GasTokenChip
                  label="MON"
                  active={gasMode !== "erc20"}
                  onClick={() => onSelectGasToken(null)}
                />
                {viableGasTokens.map((t) => (
                  <GasTokenChip
                    key={t.address}
                    label={t.symbol}
                    active={
                      gasMode === "erc20" &&
                      erc20GasToken?.address.toLowerCase() === t.address.toLowerCase()
                    }
                    onClick={() => onSelectGasToken(t.address)}
                  />
                ))}
              </div>
            </div>
          )}
          <div className="hairline mt-1 pt-3">
            <SummaryRow label="Total sender cost" value={totalSenderCost} strong />
          </div>
        </div>

        {protection && (
          <div className="mt-3 space-y-2 rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4">
            <div className="flex items-center justify-between">
              <span className="label">Execution safety</span>
              <Shield className="h-4 w-4 text-emerald-300/70" />
            </div>
            <SafetyRow
              label="MEV protection"
              value={protection.mev.active ? "Active" : "Unavailable"}
              tone={protection.mev.active ? "ok" : "warn"}
              sub={
                protection.mev.active
                  ? "private submission"
                  : "no private path on Monad"
              }
            />
            <SafetyRow
              label="Slippage protection"
              value={protection.slippage.state === "SLIPPAGE_PROTECTION_ACTIVE" ? "Active" : "Unavailable"}
              tone="ok"
              sub={`max ${(protection.slippage.bps / 100).toFixed(2)}%`}
            />
            <SafetyRow
              label="Price impact"
              value={formatImpact(protection.priceImpact.value) ?? "Unavailable"}
              tone={protection.priceImpact.blocked ? "bad" : "ok"}
              sub={
                protection.priceImpact.state === "PRICE_IMPACT_PROTECTION_ACTIVE"
                  ? `limit ${(protection.priceImpact.max * 100).toFixed(2)}%`
                  : "not measurable"
              }
            />
            <SafetyRow
              label="Minimum received"
              value={`${formatAmount(econ.minimumReceived)} ${receiveToken.symbol}`}
              sub={econ.exact ? "exact output" : "enforced on-chain"}
            />
            <SafetyRow
              label="Quote freshness"
              value={quoteStale ? "Expired" : "Fresh"}
              tone={quoteStale ? "warn" : "ok"}
              sub={`window ${(protection.freshnessMs / 1000).toFixed(0)}s`}
            />
            {partial && partial.mode !== "direct" && (
              <SafetyRow
                label="Delivery plan"
                value="Partial + convert"
                sub={
                  partial.sourceSymbol
                    ? `${formatAmount(partial.held)} ${receiveToken.symbol} held + ${formatAmount(
                        partial.shortfall,
                      )} ${receiveToken.symbol} via ${partial.sourceSymbol}`
                    : "shortfall source unknown"
                }
              />
            )}
            <SafetyRow
              label="On-chain deadline"
              value={protection.onchainDeadlineSupported ? "Enforced" : "Unavailable"}
              tone={protection.onchainDeadlineSupported ? "ok" : "warn"}
              sub={protection.onchainDeadlineSupported ? "swap reverts after it" : "router has no deadline"}
            />
            <SafetyRow
              label="Gas payment"
              value={
                gasMode === "erc20"
                  ? `ERC-20 (${erc20GasToken?.symbol ?? "token"})`
                  : gasMode === "sponsored"
                    ? "Sponsored"
                    : "MON"
              }
              tone={gasMode === "native" && gasInfo?.reason ? "warn" : "ok"}
              sub={
                gasMode === "erc20"
                  ? "same wallet · EIP-7702"
                  : gasInfo?.reason
                    ? gasInfo.reason
                    : "native network fee"
              }
            />
          </div>
        )}

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
                    Uniswap V3 · Monad
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/40">Swap mode</span>
                  <span className="font-mono text-white/70">
                    {quote.exactOutput ? "Exact output" : "Exact input"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-white/40">On-chain bound</span>
                  <span className="font-mono text-white/70">
                    {quote.exactOutput ? "amountInMaximum" : "amountOutMinimum"}
                  </span>
                </div>
                {protection && (
                  <div className="flex items-center justify-between">
                    <span className="text-white/40">MEV protection</span>
                    <span className="font-mono text-white/70">
                      {protection.mev.active ? "Private submission" : "Unavailable"}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-white/40">Gas</span>
                  <span className="font-mono text-white/70">
                    {gasMode === "sponsored"
                      ? "Sponsored (Alchemy)"
                      : gasMode === "erc20"
                        ? "Paid in an ERC-20 (chosen by your wallet)"
                        : "Paid in MON"}
                  </span>
                </div>
                {batchable && (
                  <div className="flex items-center justify-between">
                    <span className="text-white/40">Submission</span>
                    <span className="font-mono text-white/70">Atomic batch (EIP-5792)</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-white/40">Price source</span>
                  <span className="font-mono text-white/70">
                    {`Pay: ${quote.payPriceSource ?? "—"} · Receive: ${quote.receivePriceSource ?? "—"}`}
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
              <div className="min-w-0 flex-1">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={confirming || quoteStale}
                  className="btn-ghost mt-2 w-full px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Retry payment
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="sticky bottom-0 border-t border-white/[0.06] bg-ink-850/90 px-5 py-4 backdrop-blur-xl sm:px-6">
        <div className="flex gap-2.5">
          <button onClick={onBack} className="btn-ghost px-4" disabled={confirming}>
            Back
          </button>
          <button
            onClick={onConfirm}
            className="btn-primary flex-1"
            disabled={confirming || quoteStale || !canConfirm}
          >
            {confirming
              ? "Sending…"
              : quoteStale || !canConfirm
                ? "Refreshing price…"
                : `Confirm & Send ${usdTokenLabel(quote.receiveUsd, receiveToken.symbol)}`}
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

/**
 * One execution-safety line. `tone` colours the value honestly: a protection
 * that is not active is amber, a blocked route is red — never a green claim
 * that isn't true.
 */
function SafetyRow({
  label,
  value,
  sub,
  tone = "ok",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "warn" | "bad";
}) {
  const toneClass =
    tone === "bad" ? "text-red-300" : tone === "warn" ? "text-amber-200" : "text-emerald-200";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white/45">{label}</span>
      <span className="flex items-baseline gap-2 text-right">
        <span className={`num text-sm font-medium ${toneClass}`}>{value}</span>
        {sub && <span className="text-[11px] text-white/35">{sub}</span>}
      </span>
    </div>
  );
}

/**
 * A selectable gas-token chip. Kept intentionally plain: selection is a real
 * canonical-intent change (it rebuilds the transaction), not a display toggle.
 */
function GasTokenChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
        active
          ? "border-mono/50 bg-mono/15 text-white"
          : "border-white/10 bg-white/[0.02] text-white/55 hover:border-white/25 hover:text-white/80"
      }`}
    >
      {label}
    </button>
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
