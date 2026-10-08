"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";
import type { Balance } from "@/lib/domain/intent";
import type { Clarification } from "@/lib/nlp/question";
import type { IntentState, MissingField, ParsedPaymentIntent } from "@/lib/nlp/schema";
import type { ComposeHandoff } from "@/lib/nlp/handoff";

/**
 * Client for the natural-language Intent Engine.
 *
 * It is deliberately self-contained and non-blocking: if the endpoint fails,
 * the hook reports an error and the existing form-based composer keeps working.
 *
 * Every request carries a monotonic id. Only the newest response may update the
 * hook's state, so a slow request for an earlier sentence can never overwrite
 * the result of a later one.
 */

export type NlpAsset = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  native: boolean;
  tint: string;
  held: boolean;
  balance?: string;
  usd?: number;
  requiresSwap: boolean;
};

/** The outcome of resolving a ticker the user named that wasn't catalogued. */
export type NlpResolution =
  | { status: "resolved"; symbol: string; address: string; decimals: number; name: string; listed: boolean; source?: string }
  | {
      status: "ambiguous";
      query: string;
      matches: {
        address: string;
        symbol: string;
        name: string;
        decimals: number;
        listed: boolean;
        source?: string;
        logoURI?: string;
      }[];
    }
  | { status: "not_found"; query: string };

export type NlpResult = {
  ok: true;
  network: MonadNetwork;
  llm: boolean;
  state: IntentState;
  missing: MissingField;
  draft: ParsedPaymentIntent;
  clarification: Clarification;
  understood: string[];
  assets: NlpAsset[];
  resolution: NlpResolution | null;
  /** The wallet's real holding of the requested asset + any shortfall. */
  holding: {
    token: string;
    address: string;
    held: string;
    needed: string | null;
    shortfall: string | null;
    mode?: "direct" | "swap" | "split";
  } | null;
  compose: ComposeHandoff | null;
  handoff: { summary: string; price: number | null } | null;
  error: { code: string; message: string } | null;
};

/**
 * @param baseDraft the collected draft, derived from the *canonical intent* by
 *   the caller. It is not stored here — the hook holds no payment state of its
 *   own, so the chat can never drift from the composer. It is only echoed back
 *   to the server so a follow-up answer ("to 0x…") continues the same draft.
 */
export function useIntentEngine(
  network: MonadNetwork,
  balances: Balance[],
  baseDraft: ParsedPaymentIntent | null = null,
) {
  const [result, setResult] = useState<NlpResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  // Read the latest base draft inside `submit` without re-creating the callback
  // (which would abort an in-flight parse on every render).
  const baseDraftRef = useRef(baseDraft);
  baseDraftRef.current = baseDraft;

  const balancesKey = useMemo(
    () =>
      balances
        .map((b) => `${b.token.address}:${b.amount}`)
        .sort()
        .join(","),
    [balances],
  );

  const submit = useCallback(
    async (text: string) => {
      const message = (text ?? "").trim();
      if (!message) return;
      const requestId = ++reqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/nlp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: message,
            network,
            // Real balances only — the engine never invents holdings.
            balances: balances.map((b) => ({
              token: { symbol: b.token.symbol, address: b.token.address },
              amount: b.amount,
              usd: b.usd,
            })),
            // The collected draft comes from the canonical intent, so a
            // follow-up continues exactly the state the composer shows.
            draft: baseDraftRef.current,
          }),
        });
        const json = await res.json();
        // A response for an older sentence must not overwrite a newer one.
        if (requestId !== reqRef.current) return;
        if (!json?.ok) {
          setError(json?.message ?? "The intent assistant couldn't understand that.");
          return;
        }
        setResult(json as NlpResult);
        setError(null);
      } catch {
        if (requestId !== reqRef.current) return;
        setError(
          "The intent assistant is unavailable. You can still set up the payment with the form below.",
        );
      } finally {
        if (requestId === reqRef.current) setLoading(false);
      }
    },
    // balancesKey restarts the callback when real balances change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network, balancesKey],
  );

  const reset = useCallback(() => {
    reqRef.current++;
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  return { result, loading, error, submit, reset };
}

/**
 * Debounce a value. Used so natural-language input only triggers a parse after
 * the user pauses typing, not on every keystroke.
 */
export function useDebounced<T>(value: T, delayMs = 450): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
