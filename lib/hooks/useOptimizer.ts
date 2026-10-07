"use client";

import { useEffect, useRef, useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";
import type { AppMode } from "@/lib/providers";
import type { AmountMode, Balance, PaymentIntent } from "@/lib/domain/intent";
import { isEvmAddress } from "@/lib/format";

export type PaymentOption = {
  symbol: string;
  ok: boolean;
  payAmount?: string;
  payUsd?: number;
  receiveUsd?: number;
  routePath?: string[];
  totalSenderCostUsd?: number;
  sufficient: boolean;
  reason?: string;
};

export type OptimizeResult = {
  best: PaymentOption | null;
  options: PaymentOption[];
};

/**
 * Ask the server to rank the wallet's assets as ways to pay the current intent.
 * Debounced and aborted on change so it never fights the main quote request.
 */
export function useOptimizer(
  intent: PaymentIntent,
  balances: Balance[],
  mode: AppMode,
  network: MonadNetwork,
) {
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const fundedKey = balances
    .filter((b) => b.usd > 0)
    .map((b) => `${b.token.symbol}:${b.amount}`)
    .sort()
    .join(",");

  useEffect(() => {
    if (!isEvmAddress(intent.recipient) || !intent.receiveAmount || balances.length === 0) {
      setResult(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/optimize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: intent.recipient,
            receiveToken: intent.receiveToken,
            receiveAmount: intent.receiveAmount,
            amountMode: intent.amountMode,
            mode,
            network,
            balances: balances.map((b) => ({
              token: { symbol: b.token.symbol },
              amount: b.amount,
              usd: b.usd,
            })),
          }),
          signal: controller.signal,
        });
        const json = await res.json();
        if (controller.signal.aborted) return;
        setResult(json?.ok ? { best: json.best, options: json.options } : null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setResult(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 450);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    intent.recipient,
    intent.receiveToken,
    intent.receiveAmount,
    intent.amountMode,
    mode,
    network,
    fundedKey,
  ]);

  return { result, loading };
}
