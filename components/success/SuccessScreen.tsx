"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion, AnimatePresence } from "framer-motion";
import type { TokenConfig } from "@/lib/config/tokens";
import { explorerTxUrl, type MonadNetwork } from "@/lib/config/chains";
import { shortAddress, usdTokenLabel } from "@/lib/format";
import { TokenBadge } from "@/components/ui/TokenBadge";
import { Check, Copy, ExternalLink } from "@/components/ui/Icons";

/**
 * Delivery experience. A short visual delivery animation, then the exact facts:
 * what was delivered, to whom, and the transaction hash.
 */
export function SuccessScreen({
  payToken,
  receiveToken,
  payAmount,
  payUsd,
  receiveAmount,
  receiveUsd,
  recipient,
  txHash,
  network,
  demo,
  onReset,
  delivery,
}: {
  payToken: TokenConfig;
  receiveToken: TokenConfig;
  payAmount: string;
  payUsd: number;
  receiveAmount: string;
  receiveUsd: number;
  recipient: string;
  txHash?: string;
  network: MonadNetwork;
  demo: boolean;
  onReset: () => void;
  /** On-chain proof that the recipient received the intended amount. */
  delivery?: { verified: boolean; delivered: string; expected: string; reason?: string } | null;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState(reduce ? 4 : 0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (reduce) return;
    const timers = [
      setTimeout(() => setPhase(1), 420),
      setTimeout(() => setPhase(2), 900),
      setTimeout(() => setPhase(3), 1380),
      setTimeout(() => setPhase(4), 1800),
    ];
    return () => timers.forEach(clearTimeout);
  }, [reduce]);

  const copy = async () => {
    if (!txHash) return;
    try {
      await navigator.clipboard.writeText(txHash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const phaseCaption = [
    "Preparing payment",
    `Paying ${usdTokenLabel(payUsd, payToken.symbol)}`,
    "Converting",
    `Delivering ${usdTokenLabel(receiveUsd, receiveToken.symbol)}`,
    "",
  ][phase];

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
      <div className="relative mb-4 flex h-24 w-24 items-center justify-center">
        {phase >= 4 ? (
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 18 }}
            className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-400/15 ring-1 ring-emerald-400/40"
          >
            <Check className="h-9 w-9 text-emerald-300" />
          </motion.div>
        ) : (
          <motion.div
            key={phase >= 2 ? "recv" : "pay"}
            initial={{ scale: 0.85, opacity: 0.4 }}
            animate={{ scale: 1, opacity: 1 }}
          >
            <TokenBadge token={phase >= 2 ? receiveToken : payToken} size={64} />
          </motion.div>
        )}
      </div>

      <div className="mb-3 h-5">
        <AnimatePresence mode="wait">
          {phase < 4 && (
            <motion.p
              key={phaseCaption}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="text-xs font-medium uppercase tracking-[0.14em] text-white/40"
            >
              {phaseCaption}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: phase >= 4 ? 1 : 0.2, y: 0 }}
        className="num text-3xl font-semibold tracking-tight text-white sm:text-4xl"
      >
        {usdTokenLabel(receiveUsd, receiveToken.symbol)} delivered
      </motion.h2>
      <p className="mt-2 text-sm text-white/50">
        {demo ? "Demo delivery complete" : "Confirmed on Monad"} · to{" "}
        <span className="font-mono text-white/75">{shortAddress(recipient, 6)}</span>
      </p>

      <div className="mt-6 w-full max-w-sm rounded-2xl border border-white/[0.07] bg-ink-800/40 p-4 text-left">
        <Row label="You paid" value={usdTokenLabel(payUsd, payToken.symbol)} sub={`${payAmount} ${payToken.symbol}`} />
        <Row label="They received" value={usdTokenLabel(receiveUsd, receiveToken.symbol)} sub={`${receiveAmount} ${receiveToken.symbol}`} strong />
        <Row label="Network" value={network === "mainnet" ? "Monad" : "Monad Testnet"} />
      </div>

      {!demo && delivery && (
        <div
          className={`mt-4 w-full max-w-sm rounded-2xl border px-4 py-3 text-left text-xs ${
            delivery.verified
              ? "border-emerald-400/25 bg-emerald-400/[0.06] text-emerald-100/90"
              : "border-amber-400/25 bg-amber-400/[0.06] text-amber-100/90"
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            <Check className="h-3.5 w-3.5" />
            {delivery.verified
              ? "Delivery verified on-chain"
              : "Delivery could not be fully verified"}
          </div>
          <p className="mt-1 text-white/60">
            Recipient received {delivery.delivered} {receiveToken.symbol}
            {delivery.verified ? "" : ` (expected ${delivery.expected})`}.
            {delivery.reason ? ` ${delivery.reason}.` : ""}
          </p>
        </div>
      )}

      {txHash ? (
        <div className="mt-4 w-full max-w-sm">
          <div className="flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-ink-900/60 px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/70">{txHash}</span>
            <button onClick={copy} className="rounded-lg p-1.5 text-white/50 transition hover:bg-white/10 hover:text-white" aria-label="Copy hash">
              {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <a
            href={explorerTxUrl(network, txHash)}
            target="_blank"
            rel="noreferrer"
            className="btn-ghost mt-3 w-full py-2.5 text-sm"
          >
            <ExternalLink className="h-4 w-4" /> View on explorer
          </a>
        </div>
      ) : demo ? (
        <p className="mt-4 max-w-sm rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-200/90">
          Demo mode — no transaction was sent and no hash exists. Switch to Live mode to pay on Monad.
        </p>
      ) : null}

      <button onClick={onReset} className="btn-primary mt-6 w-full max-w-sm">
        Make another payment
      </button>
    </div>
  );
}

function Row({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-white/45">{label}</span>
      <span className="text-right">
        <span className={`num block text-sm ${strong ? "font-semibold text-white" : "text-white/85"}`}>{value}</span>
        {sub && <span className="num block text-[11px] text-white/40">{sub}</span>}
      </span>
    </div>
  );
}
