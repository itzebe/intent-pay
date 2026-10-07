"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getToken, allTokens, registerToken, type TokenConfig } from "@/lib/config/tokens";
import type { AmountMode, Balance, PaymentIntent, Quote } from "@/lib/domain/intent";
import type { MonadNetwork } from "@/lib/config/chains";
import { parseUnits } from "@/lib/domain/math";
import { isEvmAddress } from "@/lib/format";
import {
  isQuoteStale,
  QUOTE_REFRESH_AFTER_MS,
} from "@/lib/domain/freshness";
import { useCapabilities, type Capabilities } from "@/lib/hooks/useCapabilities";
import { useOptimizer, type OptimizeResult } from "@/lib/hooks/useOptimizer";
import { computeReadiness, type Readiness } from "@/lib/domain/readiness";

export type QuoteError = {
  code: string;
  message: string;
  alternatives?: string[];
};

type FlowState = {
  network: MonadNetwork;
  intent: PaymentIntent;
  payToken: string;
  /**
   * How the payment asset was established:
   *  - "user"      — the user explicitly selected it,
   *  - "intent"    — deterministically fixed by the user's own instruction
   *                  (e.g. "Send 10 MON" means pay MON),
   *  - "recommended" — the optimizer suggested it, which is NOT a commitment.
   * A payment cannot enter Review while the source is merely "recommended".
   */
  payTokenSource: "user" | "intent" | "recommended";
  /** Snapshot of the recipient amount the user explicitly asked for. */
  intendedReceiveAmount: string | null;
  quote: Quote | null;
  quoting: boolean;
  quoteError: QuoteError | null;
  balances: Balance[];
  balancesLoading: boolean;
  /** Bumped whenever the token registry gains a discovered token. */
  tokensVersion: number;
  /** Wall-clock (ms) when the current quote finished resolving. */
  autoRefreshAt: number;
};

type FlowContextValue = FlowState & {
  setNetwork: (network: MonadNetwork) => void;
  setRecipient: (recipient: string) => void;
  setReceiveToken: (symbol: string) => void;
  setReceiveAmount: (amount: string) => void;
  setAmountMode: (mode: AmountMode) => void;
  setPayToken: (symbol: string, manual?: boolean) => void;
  /** True once the user has explicitly acted to set the recipient address. */
  recipientConfirmed: boolean;
  markRecipientConfirmed: (confirmed: boolean) => void;
  setBalances: (balances: Balance[]) => void;
  setBalancesLoading: (loading: boolean) => void;
  /** Register a token resolved by the server (paste-an-address flow). */
  addToken: (token: TokenConfig) => void;
  refreshQuote: () => void;
  /** Restore the transaction to the intended recipient amount. */
  correctToIntended: () => void;
  /**
   * Pre-fill the composer from a completed natural-language intent. Used by the
   * Intent Engine card: it copies the collected fields in and lets the existing
   * quote/route/review flow take over from there.
   */
  prefillFromIntent: (input: {
    recipient: string;
    receiveToken: string;
    receiveAmountUsd: string;
    amountMode?: AmountMode;
    payToken?: string;
    payTokenSource?: "user" | "intent";
  }) => void;
  recommendedPayToken: string | null;
  balanceFor: (symbol: string) => Balance | undefined;
  receiveTokenConfig: TokenConfig;
  payTokenConfig: TokenConfig;
  /** Configured infrastructure (routing/pricing/wallet intelligence/gas). */
  capabilities: Capabilities | null;
  /** Ranked payment assets from the gas-aware optimizer. */
  optimizer: OptimizeResult | null;
  optimizerLoading: boolean;
  /** Amount mismatch protection, when applicable. */
  mismatch: {
    active: boolean;
    intended: string;
    current: string;
    difference: string;
  } | null;
  /**
   * True when the live quote is older than its freshness window. Execution must
   * be blocked until a fresh quote is produced, so we never sign a stale price.
   */
  quoteStale: boolean;
  sufficiency: {
    status: "ok" | "insufficient" | "unknown";
    required: string;
    available: string;
    shortfall: string;
  };
  /**
   * Whether the wallet can cover the network fee. Monad fees are paid in MON,
   * so a wallet that holds the payment asset but no MON is blocked on gas. When
   * sponsorship / ERC-20 gas is configured this is always "ok".
   */
  gasSufficiency: {
    status: "ok" | "insufficient" | "unknown";
    requiredMon: string;
    availableMon: string;
  };
  /**
   * Deterministic readiness gate. The Review/Confirm action is only reachable
   * when `readiness.ready` is true; the CTA label comes from here too.
   */
  readiness: Readiness;
};

const FlowContext = createContext<FlowContextValue | null>(null);

const MISM = 0.005; // 0.5% tolerance for the exact-payment protection

export function PaymentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<FlowState>({
    network: "mainnet",
    // The form composer is USD-denominated ("recipient receives $X of TOKEN").
    // Defaults are arbitrary starting points the user edits — not demo data.
    intent: {
      recipient: "",
      receiveToken: "USDC",
      receiveAmount: "5",
      amountMode: "recipient_receives",
    },
    payToken: "USDC",
    // The starting form is a helper default, never a commitment: the user must
    // still choose the asset before Review can be reached.
    payTokenSource: "recommended",
    intendedReceiveAmount: "5",
    quote: null,
    quoting: false,
    quoteError: null,
    balances: [],
    balancesLoading: false,
    tokensVersion: 0,
    autoRefreshAt: 0,
  });

  const [recipientConfirmed, setRecipientConfirmed] = useState(false);

  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const receiveTokenConfig = useMemo(
    () => getToken(state.intent.receiveToken) ?? allTokens()[0],
    // tokensVersion re-reads the registry after a discovered token registers.
    [state.intent.receiveToken, state.tokensVersion],
  );
  const payTokenConfig = useMemo(
    () => getToken(state.payToken) ?? allTokens()[1] ?? allTokens()[0],
    [state.payToken, state.tokensVersion],
  );

  // ---- Auto quote (debounced) ---------------------------------------------
  useEffect(() => {
    const { intent, payToken, network } = state;
    // Don't spam the network for obviously invalid input.
    if (!isEvmAddress(intent.recipient) || !intent.receiveAmount) {
      setState((s) => ({ ...s, quote: null, quoteError: null, quoting: false }));
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((s) => ({ ...s, quoting: true, quoteError: null }));

    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...intent,
            payToken,
            network,
          }),
          signal: controller.signal,
        });
        const json = await res.json();
        if (controller.signal.aborted) return;
        if (json.ok) {
          const q = json.quote as Quote;
          q.gasLimit = q.gasLimit ? (BigInt(q.gasLimit) as unknown as bigint) : undefined;
          q.gasPriceWei = q.gasPriceWei ? (BigInt(q.gasPriceWei) as unknown as bigint) : undefined;
          // Register any discovered tokens (route hops, resolved endpoints) so
          // the UI and the transaction builder can resolve them by symbol.
          let learned = false;
          for (const t of [q.payToken, q.receiveToken, ...(q.route.tokens ?? [])]) {
            if (t?.address) {
              const before = getToken(t.symbol)?.address;
              registerToken(t);
              if (before?.toLowerCase() !== t.address.toLowerCase()) learned = true;
            }
          }
          setState((s) => ({
            ...s,
            quote: q,
            quoting: false,
            quoteError: null,
            autoRefreshAt: Date.now(),
            tokensVersion: learned ? s.tokensVersion + 1 : s.tokensVersion,
            // In "I spend" mode the recipient amount is derived, so the intent
            // snapshot tracks the current implied value rather than a fixed one.
            intendedReceiveAmount:
              s.intent.amountMode === "i_spend"
                ? q.receiveUsd.toFixed(2)
                : s.intendedReceiveAmount,
          }));
        } else {
          setState((s) => ({
            ...s,
            quote: null,
            quoting: false,
            quoteError: {
              code: json.code ?? "provider_error",
              message: json.message ?? "Could not build a quote.",
              alternatives: json.alternatives,
            },
          }));
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setState((s) => ({
          ...s,
          quote: null,
          quoting: false,
          quoteError: { code: "provider_error", message: "Couldn't reach the routing service." },
        }));
      }
    }, 320);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    state.intent.recipient,
    state.intent.receiveToken,
    state.intent.receiveAmount,
    state.intent.amountMode,
    state.payToken,
    state.network,
    nonce,
  ]);

  // ---- Setters -------------------------------------------------------------
  const setNetwork = useCallback((network: MonadNetwork) => {
    setState((s) => ({ ...s, network, quote: null, quoteError: null }));
  }, []);
  const setRecipient = useCallback((recipient: string) => {
    setState((s) => ({ ...s, intent: { ...s.intent, recipient } }));
    // Typing (or clearing) the address invalidates a previous confirmation.
    setRecipientConfirmed(false);
  }, []);
  const setReceiveToken = useCallback((symbol: string) => {
    setState((s) => ({ ...s, intent: { ...s.intent, receiveToken: symbol } }));
  }, []);
  const setReceiveAmount = useCallback((amount: string) => {
    setState((s) => ({
      ...s,
      intent: { ...s.intent, receiveAmount: amount },
      intendedReceiveAmount:
        s.intent.amountMode === "recipient_receives" ? amount : s.intendedReceiveAmount,
    }));
  }, []);
  const setAmountMode = useCallback((mode: AmountMode) => {
    setState((s) => ({
      ...s,
      intent: { ...s.intent, amountMode: mode },
      quote: null,
      // "Recipient receives" pins the entered amount; "I spend" derives it.
      intendedReceiveAmount: mode === "recipient_receives" ? s.intent.receiveAmount : null,
    }));
  }, []);
  const setPayToken = useCallback((symbol: string, manual = true) => {
    setState((s) => ({
      ...s,
      payToken: symbol,
      // An explicit selection is a commitment; an optimizer suggestion is not.
      payTokenSource: manual ? "user" : "recommended",
    }));
  }, []);
  const setBalances = useCallback((balances: Balance[]) => {
    setState((s) => ({ ...s, balances }));
  }, []);
  const setBalancesLoading = useCallback((loading: boolean) => {
    setState((s) => ({ ...s, balancesLoading: loading }));
  }, []);
  const addToken = useCallback((token: TokenConfig) => {
    registerToken(token);
    setState((s) => ({ ...s, tokensVersion: s.tokensVersion + 1 }));
  }, []);
  const refreshQuote = useCallback(() => setNonce((n) => n + 1), []);

  const correctToIntended = useCallback(() => {
    setState((s) => {
      if (!s.intendedReceiveAmount) return s;
      return {
        ...s,
        intent: {
          ...s.intent,
          amountMode: "recipient_receives",
          receiveAmount: s.intendedReceiveAmount,
        },
      };
    });
    setNonce((n) => n + 1);
  }, []);

  const prefillFromIntent = useCallback(
    (input: {
      recipient: string;
      receiveToken: string;
      receiveAmountUsd: string;
      amountMode?: AmountMode;
      payToken?: string;
      payTokenSource?: "user" | "intent";
    }) => {
      setState((s) => {
        const amountMode = input.amountMode ?? "recipient_receives";
        return {
          ...s,
          intent: {
            ...s.intent,
            recipient: input.recipient,
            receiveToken: input.receiveToken,
            receiveAmount: input.receiveAmountUsd,
            amountMode,
          },
          // Pin the recipient amount as the intent.
          intendedReceiveAmount:
            amountMode === "recipient_receives" ? input.receiveAmountUsd : null,
          // When the instruction deterministically named a source asset
          // ("Use USDT to send $10 USDC" / "Send 10 MON"), honour it. When it
          // did not, the source is only *recommended* by the optimizer and the
          // user must still confirm it before Review.
          payToken: input.payToken ?? s.payToken,
          payTokenSource: input.payToken
            ? input.payTokenSource ?? "intent"
            : "recommended",
          quote: null,
          quoteError: null,
        };
      });
      setRecipientConfirmed(true);
      setNonce((n) => n + 1);
    },
    [],
  );

  const balanceFor = useCallback(
    (symbol: string) => state.balances.find((b) => b.token.symbol === symbol),
    [state.balances],
  );

  // ---- Configured infrastructure -------------------------------------------
  const capabilities = useCapabilities(state.network);

  // ---- Gas-aware payment optimizer -----------------------------------------
  // Ranks every funded asset as a way to satisfy the intent, weighing route
  // availability, amount, and network cost. This is what makes the
  // recommendation honest: a token is only "best" if it can actually pay.
  const { result: optimizer, loading: optimizerLoading } = useOptimizer(
    state.intent,
    state.balances,
    state.network,
  );

  const recommendedPayToken = useMemo(() => {
    if (optimizer?.best) return optimizer.best.symbol;
    // Fall back to the largest holding while the optimizer is still thinking.
    const funded = state.balances.filter((b) => b.usd > 0).sort((a, b) => b.usd - a.usd);
    return funded[0]?.token.symbol ?? null;
  }, [optimizer, state.balances]);

  // Keep the recommendation in sync until the user chooses manually, or the
  // instruction already established the source. We never silently override an
  // explicit choice or an intent-established asset.
  useEffect(() => {
    if (state.payTokenSource !== "recommended") return;
    if (!recommendedPayToken) return;
    if (recommendedPayToken === state.payToken) return;
    setState((s) => ({ ...s, payToken: recommendedPayToken }));
  }, [recommendedPayToken, state.payTokenSource, state.payToken]);

  // ---- Exact-payment protection -------------------------------------------
  const mismatch = useMemo(() => {
    // The user's intent is a dollar value ("$5.00 SOL"); compare it against the
    // dollar value the current configuration would actually deliver. Protection
    // fires only when the recipient would receive MORE than intended — a
    // shortfall is a normal consequence of "I spend" mode, not an overpayment.
    const intended = state.intendedReceiveAmount;
    if (!intended || !state.quote) return null;
    const a = Number(intended);
    const b = state.quote.receiveUsd;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
    const diff = b - a;
    if (diff <= 0 || diff / a <= MISM) return null;
    return {
      active: true,
      intended: `$${a.toFixed(2)} ${state.intent.receiveToken}`,
      current: `$${b.toFixed(2)} ${state.intent.receiveToken}`,
      difference: `+$${diff.toFixed(2)}`,
    };
  }, [state.intendedReceiveAmount, state.quote, state.intent.receiveToken]);

  // ---- Quote freshness -----------------------------------------------------
  // A quote is only trustworthy for a short window. We auto-refresh shortly
  // before it goes stale, and while it is stale the UI blocks execution so a
  // price the user saw is never the price they sign.
  const quoteStale = isQuoteStale(state.autoRefreshAt);

  // Proactively refresh as the quote approaches staleness (delay 0 when it has
  // already aged out, so a long-idle tab recovers immediately).
  useEffect(() => {
    if (!state.quote || !state.autoRefreshAt) return;
    const delay = Math.max(
      0,
      QUOTE_REFRESH_AFTER_MS - (Date.now() - state.autoRefreshAt),
    );
    const timer = setTimeout(() => setNonce((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [state.quote, state.autoRefreshAt]);

  // ---- Balance sufficiency -------------------------------------------------
  const sufficiency = useMemo(() => {
    const q = state.quote;
    const bal = state.balances.find((b) => b.token.symbol === state.payToken);
    if (!q || !bal) {
      return { status: "unknown" as const, required: q?.payAmount ?? "0", available: bal?.amount ?? "0", shortfall: "0" };
    }
    try {
      const required = parseUnits(q.payAmount, payTokenConfig.decimals);
      // Leave a little MON for gas when paying with the native asset.
      const reserve = payTokenConfig.native ? 10_000_000_000_000_000n : 0n;
      const available = parseUnits(bal.amount, payTokenConfig.decimals);
      if (available >= required + reserve) {
        return { status: "ok" as const, required: q.payAmount, available: bal.amount, shortfall: "0" };
      }
      const short = required + reserve - available;
      const shortfall = Number(short) / 10 ** payTokenConfig.decimals;
      return {
        status: "insufficient" as const,
        required: q.payAmount,
        available: bal.amount,
        shortfall: shortfall.toFixed(6),
      };
    } catch {
      return { status: "unknown" as const, required: q.payAmount, available: bal.amount, shortfall: "0" };
    }
  }, [state.quote, state.balances, state.payToken, payTokenConfig]);

  // ---- Network-fee (gas) sufficiency --------------------------------------
  // Monad fees are paid in MON. A wallet that holds the payment asset but no
  // MON can't submit — unless a paymaster is configured. We surface this as its
  // own, plainly-worded state so the user never sees a raw "insufficient funds"
  // error. When sponsorship is configured we don't claim a MON shortfall.
  const gasSufficiency = useMemo(() => {
    const native = state.balances.find((b) => b.token.native);
    const availableMon = native?.amount ?? "0";
    if (capabilities?.gas.sponsorshipConfigured) {
      return { status: "ok" as const, requiredMon: "0", availableMon };
    }
    // No native balance entry means no wallet is connected / balances are not
    // loaded yet. We don't know the fee position, so don't block on it.
    if (!native) {
      return { status: "unknown" as const, requiredMon: "0", availableMon };
    }
    const q = state.quote;
    if (!q?.gasLimit || !q?.gasPriceWei) {
      return { status: "unknown" as const, requiredMon: "0", availableMon };
    }
    try {
      const required = q.gasLimit * q.gasPriceWei;
      const requiredMon = Number(required) / 1e18;
      // The gas price can move between quote and send; require a small buffer.
      const buffered = required + required / 5n;
      const available = parseUnits(availableMon, 18);
      if (available >= buffered) {
        return { status: "ok" as const, requiredMon: requiredMon.toFixed(6), availableMon };
      }
      return { status: "insufficient" as const, requiredMon: requiredMon.toFixed(6), availableMon };
    } catch {
      return { status: "unknown" as const, requiredMon: "0", availableMon };
    }
  }, [state.quote, state.balances, capabilities]);

  // ---- Deterministic readiness gate ---------------------------------------
  // The single authority for whether Review/Confirm is reachable. Visual state
  // is never the only gate: `onConfirm` re-checks readiness and freshness.
  const payTokenIsSet = state.payTokenSource === "user" || state.payTokenSource === "intent";
  const readiness = useMemo(
    () =>
      computeReadiness({
        recipient: state.intent.recipient,
        recipientConfirmed,
        payTokenIsSet,
        payToken: state.payToken,
        receiveToken: state.intent.receiveToken,
        quoting: state.quoting,
        quote: state.quote,
        quoteError: state.quoteError,
        quoteStale,
        sufficiency,
        gasSufficiency,
        mismatchActive: Boolean(mismatch?.active),
      }),
    [
      state.intent.recipient,
      recipientConfirmed,
      payTokenIsSet,
      state.payToken,
      state.intent.receiveToken,
      state.quoting,
      state.quote,
      state.quoteError,
      quoteStale,
      sufficiency,
      gasSufficiency,
      mismatch,
    ],
  );

  const value: FlowContextValue = {
    ...state,
    recipientConfirmed,
    markRecipientConfirmed: setRecipientConfirmed,
    setNetwork,
    setRecipient,
    setReceiveToken,
    setReceiveAmount,
    setAmountMode,
    setPayToken,
    setBalances,
    setBalancesLoading,
    addToken,
    refreshQuote,
    correctToIntended,
    prefillFromIntent,
    recommendedPayToken,
    balanceFor,
    receiveTokenConfig,
    payTokenConfig,
    capabilities,
    optimizer,
    optimizerLoading,
    mismatch,
    quoteStale,
    sufficiency,
    gasSufficiency,
    readiness,
  };

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function usePaymentFlow(): FlowContextValue {
  const ctx = useContext(FlowContext);
  if (!ctx) throw new Error("usePaymentFlow must be used within PaymentProvider");
  return ctx;
}

/**
 * Pure helper used by tests and the UI: does the current quote deliver a
 * different recipient amount than the user intended?
 */
export function detectAmountMismatch(
  intendedAmount: string | null,
  currentAmount: string,
  tolerance = MISM,
): { active: boolean; difference: number } {
  const a = Number(intendedAmount);
  const b = Number(currentAmount);
  if (!intendedAmount || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0) {
    return { active: false, difference: 0 };
  }
  const diff = b - a;
  return { active: diff > 0 && diff / a > tolerance, difference: diff };
}
