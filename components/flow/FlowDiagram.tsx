"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import type { Quote } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import { formatAmount, shortAddress, usdTokenLabel } from "@/lib/format";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { ArrowDown, Sparkle } from "@/components/ui/Icons";

/**
 * The signature visual: the payment as a transformation, not a swap form.
 * A token travels down the flow each time the quote recalculates, so the
 * motion communicates "your asset becomes theirs".
 */
export function FlowDiagram({
  quote,
  payToken,
  receiveToken,
  recipient,
  recipientValid,
}: {
  quote: Quote | null;
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  recipient: string;
  recipientValid: boolean;
}) {
  const reduce = useReducedMotion();
  const [travelKey, setTravelKey] = useState(0);

  useEffect(() => {
    if (!quote) return;
    setTravelKey((k) => k + 1);
  }, [quote?.quotedAt, quote?.payAmount, quote?.receiveAmount]);

  const routeLabel = quote
    ? quote.route.path.join(" → ")
    : `${payToken.symbol} → ${receiveToken.symbol}`;

  return (
    <div className="relative">
      {/* Node 1 — your asset */}
      <FlowNode
        kicker="You pay"
        accent={payToken.tint}
        leading={<TokenBadge token={payToken} size={38} />}
        title={payToken.symbol}
        value={quote ? usdTokenLabel(quote.payUsd, payToken.symbol) : "—"}
        sub={quote ? `${formatAmount(quote.payAmount)} ${payToken.symbol}` : undefined}
      />

      <Connector label={routeLabel} traveling={Boolean(quote)} reduce={reduce} travelKey={travelKey} tint={payToken.tint} />

      {/* Node 2 — recipient */}
      <FlowNode
        kicker="Recipient receives"
        accent={receiveToken.tint}
        leading={<TokenBadge token={receiveToken} size={38} />}
        title={recipientValid ? shortAddress(recipient) : "Recipient address"}
        value={quote ? usdTokenLabel(quote.receiveUsd, receiveToken.symbol) : "—"}
        sub={quote ? `${formatAmount(quote.receiveAmount)} ${receiveToken.symbol}` : undefined}
        emphasis
      />

      <AnimatePresence>
        {quote && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 flex items-center justify-center gap-2 text-[11px] text-white/35"
          >
            <Sparkle className="h-3.5 w-3.5 text-mono-soft" />
            <span>
              {quote.route.kind === "direct"
                ? "Direct transfer — no conversion needed"
                : `Best route found on Monad · ${quote.route.hops.length || 1} hop${(quote.route.hops.length || 1) > 1 ? "s" : ""}`}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FlowNode({
  kicker,
  title,
  value,
  sub,
  leading,
  accent,
  emphasis = false,
}: {
  kicker: string;
  title: string;
  value: string;
  sub?: string;
  leading: React.ReactNode;
  accent: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="relative flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-ink-800/50 px-4 py-3.5"
      style={{
        boxShadow: emphasis ? `0 0 0 1px ${accent}22 inset` : undefined,
      }}
    >
      <span
        aria-hidden
        className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
        style={{ background: accent, opacity: emphasis ? 0.9 : 0.5 }}
      />
      {leading}
      <div className="min-w-0 flex-1">
        <div className="label">{kicker}</div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className={`num truncate ${emphasis ? "text-lg font-semibold" : "text-base font-medium"} text-white`}>
            {value}
          </span>
          <span className="truncate text-xs text-white/45">{title}</span>
        </div>
      </div>
      {sub && <span className="num shrink-0 text-xs text-white/40">{sub}</span>}
    </div>
  );
}

function Connector({
  label,
  traveling,
  reduce,
  travelKey,
  tint,
}: {
  label: string;
  traveling: boolean;
  reduce: boolean | null;
  travelKey: number;
  tint: string;
}) {
  return (
    <div className="relative flex items-center gap-3 py-2 pl-4">
      <div className="relative flex h-10 w-9 items-center justify-center">
        <svg width="20" height="40" viewBox="0 0 20 40" className="text-white/15">
          <path d="M10 2 V30" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 4" />
          <path d="M5 28 L10 34 L15 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <AnimatePresence>
          {traveling && !reduce && (
            <motion.span
              key={travelKey}
              className="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full"
              style={{ background: tint, boxShadow: `0 0 12px 2px ${tint}` }}
              initial={{ y: 0, opacity: 0, scale: 0.7 }}
              animate={{ y: 30, opacity: [0, 1, 1, 0], scale: 1 }}
              transition={{ duration: 0.9, ease: "easeInOut" }}
            />
          )}
        </AnimatePresence>
      </div>
      <span className="chip">
        <ArrowDown className="h-3.5 w-3.5 text-mono-soft" />
        <span className="font-mono text-[11px] tracking-tight text-white/70">{label}</span>
      </span>
    </div>
  );
}
