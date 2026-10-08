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
import { getToken, getTokenByAddress, registerToken, tintForAddress, type TokenConfig } from "@/lib/config/tokens";
import type { AmountMode, Balance, Quote } from "@/lib/domain/intent";
import type { MonadNetwork } from "@/lib/config/chains";
import { parseUnits } from "@/lib/domain/math";
import { splitPayment, pickShortfallSource } from "@/lib/domain/partialBalance";
import { isQuoteStale, QUOTE_REFRESH_AFTER_MS } from "@/lib/domain/freshness";
import {
  initialIntent,
  isQuotable,
  reduceIntent,
  toPaymentIntent,
  type CanonicalIntent,
  type IntentPatch,
} from "@/lib/domain/canonicalIntent";
import { useCapabilities, type Capabilities } from "@/lib/hooks/useCapabilities";
import { useOptimizer, type OptimizeResult } from "@/lib/hooks/useOptimizer";
import { computeReadiness, type Readiness } from "@/lib/domain/readiness";
import { createLatestGuard } from "@/lib/domain/latest";
import { selectSource, type SourceSelection } from "@/lib/domain/sourceSelection";
import { nlDraftToIntentPatch, type NlApplyInput } from "@/lib/nlp/apply";
import { alchemyPaymasterServiceUrl, type GasMode } from "@/lib/execution/alchemy";
import { resolveAbstraction, type AbstractionResult } from "@/lib/domain/abstraction";
import { NETWORKS } from "@/lib/config/chains";

export type QuoteError = {
  code: string;
  message: string;
  alternatives?: string[];
};

/** The wallet's EIP-5792 capabilities, as probed from the injected provider. */
export type WalletGasCapabilities = {
  atomicBatch: boolean;
  paymasterService: boolean;
  erc20GasPayment: boolean;
};

/**
 * The resolved gas plan for the current payment. `mode` is only ever a mode the
 * wallet can actually deliver; `paymasterServiceUrl` is present only when a
 * paymaster is configured, and is what the wallet is handed to sponsor gas.
 */
export type GasInfo = {
  mode: GasMode;
  paymasterConfigured: boolean;
  walletSupportsPaymaster: boolean;
  walletSupportsErc20Gas: boolean;
  paymasterServiceUrl?: string;
  paymasterContext?: Record<string, unknown>;
  /** The ERC-20 that will pay gas, when the AA paymaster path is selected. */
  erc20GasToken?: { symbol: string; address: string } | null;
  /** Honest reason gas is not abstracted, when it isn't. */
  reason?: string | null;
};

/**
 * The live, per-wallet ERC-20 gas capability reported by the composer. This is
 * what lets the flow decide — honestly — between "gas paid in an ERC-20" and
 * "you need MON".
 */
export type AaGasSelection = {
  available: boolean;
  mode: "ERC20_PAYMASTER" | "NATIVE" | "UNAVAILABLE";
  tokenSymbol?: string | null;
  tokenAddress?: string | null;
  code?: string;
  reason?: string | null;
};

type FlowState = {
  /** The canonical, versioned intent — the single source of truth. */
  intent: CanonicalIntent;
  quote: Quote | null;
  /**
   * The intent version the current quote was computed for. A quote whose
   * `quoteVersion` differs from `intent.version` belongs to a previous request
   * and must never be displayed or signed.
   */
  quoteVersion: number;
  quoting: boolean;
  quoteError: QuoteError | null;
  balances: Balance[];
  balancesLoading: boolean;
  /** Bumped whenever the token registry gains a discovered token. */
  tokensVersion: number;
  /** Wall-clock (ms) when the current quote finished resolving. */
  autoRefreshAt: number;
  /** The connected wallet account, tracked so an account change invalidates. */
  walletAccount: string | undefined;
  /** Bumped periodically to drive live balance/gas revalidation. */
  revalidationTick: number;
  /** Snapshot of the recipient amount the user explicitly asked for. */
  intendedReceiveAmount: string | null;
};

type FlowContextValue = FlowState & {
  /** Raw natural-language instruction, part of the canonical intent. */
  setText: (text: string) => void;
  setNetwork: (network: MonadNetwork) => void;
  setRecipient: (recipient: string) => void;
  setReceiveToken: (symbol: string, address?: string) => void;
  setReceiveAmount: (amount: string) => void;
  setAmountMode: (mode: AmountMode) => void;
  setPayToken: (symbol: string, manual?: boolean, address?: string) => void;
  /** Apply an arbitrary canonical-intent patch (always version-checked). */
  patchIntent: (patch: IntentPatch) => void;
  /** Report the connected wallet account so a change invalidates the flow. */
  setWalletAccount: (address: string | undefined) => void;
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
   * Apply a parsed natural-language draft to the canonical intent. This is the
   * NL layer's only write path, so the composer/review/quote/plan/guard all stay
   * derived from the one canonical intent. Produces a new version when the
   * payment actually changed.
   */
  applyNlIntent: (input: NlApplyInput & { text: string }) => void;
  recommendedPayToken: string | null;
  /**
   * The deterministic source-asset selection for the current intent: the asset
   * to spend, why it was chosen, and the required amount/route/gas state.
   */
  sourceSelection: SourceSelection;
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
   * True when the live quote is older than its freshness window, or when it was
   * computed for a different intent version than the current one.
   */
  quoteStale: boolean;
  sufficiency: {
    status: "ok" | "insufficient" | "unknown";
    required: string;
    available: string;
    shortfall: string;
  };
  gasSufficiency: {
    status: "ok" | "insufficient" | "unknown";
    requiredMon: string;
    availableMon: string;
  };
  /**
   * Partial-balance eligibility for the current intent. Present only for a
   * token-quantity intent; describes how much is held, the shortfall, and which
   * funded asset would cover it. Null when the intent is not a token quantity.
   */
  partial: {
    eligible: boolean;
    mode: "direct" | "swap" | "split";
    held: string;
    shortfall: string;
    sourceSymbol: string | null;
    covered: boolean;
  } | null;
  /** How gas will actually be paid, resolved against the connected wallet. */
  gasMode: GasMode;
  /** The live gas-mode resolution, including whether the wallet is capable. */
  gasInfo: GasInfo;
  /**
   * Deterministic wallet-abstraction state for the current payment. Names the
   * exact reason abstraction is or isn't available (never a bare boolean).
   */
  abstraction: AbstractionResult;
  /** Report the wallet's EIP-5792 capabilities (from the composer's probe). */
  setWalletGasCapabilities: (caps: WalletGasCapabilities | null) => void;
  /** Report the live per-wallet ERC-20 gas capability (from the composer). */
  aaGas: AaGasSelection;
  setAaGas: (selection: AaGasSelection | null) => void;
  /** Choose the ERC-20 that pays gas (null = let the engine auto-select). */
  setGasPaymentToken: (token: { symbol: string; address?: string } | null, mode?: "NATIVE" | "ERC20_PAYMASTER") => void;
  /** Resolve the canonical gas asset for the intent, when one is chosen. */
  gasTokenConfig: TokenConfig | null;
  /**
   * Deterministic readiness gate. The Review/Confirm action is only reachable
   * when `readiness.ready` is true; the CTA label comes from here too.
   */
  readiness: Readiness;
};

const FlowContext = createContext<FlowContextValue | null>(null);

const MISM = 0.005; // 0.5% tolerance for the exact-payment protection

/** How often to revalidate balances/gas while a wallet is connected. */
const REVALIDATE_INTERVAL_MS = 12_000;

export function PaymentProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<FlowState>(() => {
    const intent = initialIntent();
    return {
      intent,
      quote: null,
      quoteVersion: 0,
      quoting: false,
      quoteError: null,
      balances: [],
      balancesLoading: false,
      tokensVersion: 0,
      autoRefreshAt: 0,
      walletAccount: undefined,
      revalidationTick: 0,
      intendedReceiveAmount: intent.receiveAmount,
    };
  });

  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [walletGasCaps, setWalletGasCapabilitiesState] = useState<WalletGasCapabilities | null>(null);
  const [aaGas, setAaGasState] = useState<AaGasSelection>({
    available: false,
    mode: "NATIVE",
    reason: null,
  });

  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Latest-only guard: a slow request for an earlier intent version can never
  // overwrite the result of a newer one.
  const latestRef = useRef(createLatestGuard());

  const receiveTokenConfig = useMemo(
    () => resolveIntentAsset(state.intent.receiveTokenAddress, state.intent.receiveToken),
    [state.intent.receiveTokenAddress, state.intent.receiveToken, state.tokensVersion],
  );
  const payTokenConfig = useMemo(
    () => resolveIntentAsset(state.intent.payTokenAddress, state.intent.payToken),
    [state.intent.payTokenAddress, state.intent.payToken, state.tokensVersion],
  );
  // The chosen gas asset (distinct from the payment source). Null when the user
  // has not chosen one — the composer then reports the engine's auto-selection.
  const gasTokenConfig = useMemo(() => {
    if (!state.intent.gasPaymentToken && !state.intent.gasPaymentTokenAddress) return null;
    return resolveIntentAsset(state.intent.gasPaymentTokenAddress, state.intent.gasPaymentToken ?? "");
  }, [state.intent.gasPaymentToken, state.intent.gasPaymentTokenAddress, state.tokensVersion]);

  // ---- Canonical intent mutation ------------------------------------------
  // Every edit goes through the reducer, which bumps the version only when an
  // execution-relevant field actually changed. A version change discards the
  // quote and any error from the previous request so a stale result can never
  // be shown for the new one.
  const patchIntent = useCallback((patch: IntentPatch) => {
    setState((s) => {
      const intent = reduceIntent(s.intent, patch);
      if (intent === s.intent) return s;
      return {
        ...s,
        intent,
        quote: null,
        quoteVersion: 0,
        quoting: false,
        quoteError: null,
        autoRefreshAt: 0,
      };
    });
  }, []);

  const setText = useCallback((text: string) => patchIntent({ text }), [patchIntent]);
  const setNetwork = useCallback(
    (network: MonadNetwork) => {
      patchIntent({ network });
      // A different chain invalidates the wallet's capabilities and gas plan.
      setWalletGasCapabilities(null);
    },
    [patchIntent],
  );
  const setRecipient = useCallback(
    (recipient: string) => {
      patchIntent({ recipient });
      // Typing (or clearing) the address invalidates a previous confirmation.
      setRecipientConfirmed(false);
    },
    [patchIntent],
  );
  const setReceiveToken = useCallback(
    (symbol: string, address?: string) => {
      // The contract address is the authoritative identity. When the caller
      // supplies one (a discovered/imported token) it wins; otherwise we look
      // the symbol up and, when it is not a known token, record *no* address
      // rather than borrowing an unrelated token's address.
      const resolvedAddress = address ?? getToken(symbol)?.address;
      patchIntent({
        receiveToken: symbol,
        receiveTokenAddress: resolvedAddress,
        // An exact token target from a previous asset no longer applies.
        receiveTokenAmount: undefined,
      });
    },
    [patchIntent],
  );
  const setReceiveAmount = useCallback(
    (amount: string) => {
      // Typing a USD amount supersedes any exact token quantity the instruction
      // had pinned (e.g. "10 MON"), so the partial-split target can't linger.
      patchIntent({ receiveAmount: amount, receiveTokenAmount: undefined });
      setState((s) =>
        s.intent.amountMode === "recipient_receives"
          ? { ...s, intendedReceiveAmount: amount }
          : s,
      );
    },
    [patchIntent],
  );
  const setAmountMode = useCallback(
    (mode: AmountMode) => {
      patchIntent({ amountMode: mode });
      setState((s) => ({
        ...s,
        intendedReceiveAmount: mode === "recipient_receives" ? s.intent.receiveAmount : null,
      }));
    },
    [patchIntent],
  );
  const setPayToken = useCallback(
    (symbol: string, manual = true, address?: string) => {
      // The caller's address (a discovered/imported token) is authoritative;
      // otherwise look the symbol up. An unknown symbol records no address
      // rather than borrowing an unrelated token's identity.
      const resolvedAddress = address ?? getToken(symbol)?.address;
      patchIntent({
        payToken: symbol,
        payTokenAddress: resolvedAddress,
        payTokenSource: manual ? "user" : "recommended",
      });
    },
    [patchIntent],
  );

  const setWalletAccount = useCallback((address: string | undefined) => {
    setState((s) => {
      if (s.walletAccount === address) return s;
      // An account change invalidates balances, allowances, smart-account state,
      // paymaster eligibility and the whole transaction payload. Drop the quote
      // so it is rebuilt from scratch for the new account.
      return {
        ...s,
        walletAccount: address,
        balances: [],
        quote: null,
        quoteVersion: 0,
        quoteError: null,
        autoRefreshAt: 0,
      };
    });
    setWalletGasCapabilities(null);
    setNonce((n) => n + 1);
  }, []);

  const setWalletGasCapabilities = useCallback((caps: WalletGasCapabilities | null) => {
    setWalletGasCapabilitiesState(caps);
  }, []);

  /**
   * Report the live ERC-20 gas capability from the composer. It is stored raw;
   * `gasInfo` decides whether it is trustworthy for the *current* intent (an
   * explicit token choice or a matching auto-selection).
   */
  const setAaGas = useCallback((selection: AaGasSelection | null) => {
    setAaGasState(selection ?? { available: false, mode: "NATIVE", reason: null });
  }, []);

  /**
   * Choose the ERC-20 that pays the network fee, or clear the choice (auto).
   * The gas token is a canonical-intent field, so a change bumps the version and
   * invalidates any earlier quote/plan — exactly like changing the source asset.
   */
  const setGasPaymentToken = useCallback(
    (token: { symbol: string; address?: string } | null, mode: "NATIVE" | "ERC20_PAYMASTER" = "ERC20_PAYMASTER") => {
      const resolvedAddress = token ? (token.address ?? getToken(token.symbol)?.address) : undefined;
      patchIntent({
        gasPaymentToken: token?.symbol,
        gasPaymentTokenAddress: resolvedAddress,
        gasPaymentMode: token ? mode : undefined,
      });
    },
    [patchIntent],
  );

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
      const intent = reduceIntent(s.intent, {
        amountMode: "recipient_receives",
        receiveAmount: s.intendedReceiveAmount,
      });
      return { ...s, intent, quote: null, quoteVersion: 0, quoteError: null };
    });
    setNonce((n) => n + 1);
  }, []);

  /**
   * Apply a parsed natural-language *draft* to the canonical intent.
   *
   * This is the only entry point the NL layer has into the payment state, so
   * there is exactly one source of truth: the chat, the composer, the quote,
   * the plan and the signing guard all read the same `state.intent`. The
   * mapping is pure (`nlDraftToIntentPatch`); here we only commit it, record
   * the explicit intended amount, and confirm a recipient the parser supplied.
   *
   * `text` is passed separately so provenance never bumps the version on its own.
   */
  const applyNlIntent = useCallback(
    (input: NlApplyInput & { text: string }) => {
      const patch = nlDraftToIntentPatch(input);
      setState((s) => {
        const nextText = input.text.trim() || s.intent.text;
        const intent = reduceIntent(s.intent, { ...patch, text: nextText });
        const sameVersion = intent.version === s.intent.version;
        return {
          ...s,
          intent,
          intendedReceiveAmount:
            patch.receiveAmount === undefined
              ? s.intendedReceiveAmount
              : intent.amountMode === "recipient_receives"
                ? intent.receiveAmount
                : null,
          // A change to the payment (new version) discards any quote from the
          // previous request so a stale result can never be shown.
          quote: sameVersion ? s.quote : null,
          quoteVersion: sameVersion ? s.quoteVersion : 0,
          quoting: sameVersion ? s.quoting : false,
          quoteError: sameVersion ? s.quoteError : null,
          autoRefreshAt: sameVersion ? s.autoRefreshAt : 0,
        };
      });
      // A parser-supplied address is an explicit recipient — confirm it so the
      // readiness gate does not require a redundant second confirmation.
      if (patch.recipient) setRecipientConfirmed(true);
      setNonce((n) => n + 1);
    },
    [],
  );

  const balanceFor = useCallback(
    (symbol: string) => state.balances.find((b) => b.token.symbol === symbol),
    [state.balances],
  );

  // ---- Configured infrastructure -------------------------------------------
  const capabilities = useCapabilities(state.intent.network);

  // ---- Gas-aware payment optimizer -----------------------------------------
  const paymentIntent = useMemo(() => toPaymentIntent(state.intent), [state.intent]);
  const { result: optimizer, loading: optimizerLoading } = useOptimizer(
    paymentIntent,
    state.balances,
    state.intent.network,
  );

  const recommendedPayToken = useMemo(() => {
    if (optimizer?.best) return optimizer.best.symbol;
    const funded = state.balances.filter((b) => b.usd > 0).sort((a, b) => b.usd - a.usd);
    return funded[0]?.token.symbol ?? null;
  }, [optimizer, state.balances]);

  // ---- Deterministic source selection -------------------------------------
  // The named asset is the RECIPIENT asset; the engine decides what to spend.
  // A sponsored paymaster / ERC-20-gas path only "covers" gas when it is
  // genuinely configured AND the wallet advertises it — never assumed.
  const gasAbstractedForSelection = Boolean(
    (capabilities?.gas.sponsorshipConfigured && walletGasCaps?.paymasterService) ||
      (aaGas.available && aaGas.mode === "ERC20_PAYMASTER"),
  );
  const sourceSelection = useMemo(
    () =>
      selectSource({
        recipientAsset: state.intent.receiveToken,
        balances: state.balances,
        options: (optimizer?.options ?? []).map((o) => ({
          symbol: o.symbol,
          ok: o.ok,
          sufficient: o.sufficient,
          payAmount: o.payAmount,
          payUsd: o.payUsd,
          routePath: o.routePath,
          totalSenderCostUsd: o.totalSenderCostUsd,
          reason: o.reason,
        })),
        explicit:
          (state.intent.payTokenSource === "user" || state.intent.payTokenSource === "intent") &&
          state.intent.payToken
            ? {
                symbol: state.intent.payToken,
                origin: state.intent.payTokenSource === "user" ? "user" : "intent",
              }
            : null,
        gasMode: aaGas.available && aaGas.mode === "ERC20_PAYMASTER" ? "erc20" : gasAbstractedForSelection ? "sponsored" : "native",
        gasAbstracted: gasAbstractedForSelection,
        pending: Boolean(state.balances.length > 0 && !optimizer && optimizerLoading),
      }),
    [
      state.intent.receiveToken,
      state.intent.payToken,
      state.intent.payTokenSource,
      state.balances,
      optimizer,
      optimizerLoading,
      gasAbstractedForSelection,
      aaGas,
    ],
  );

  // Keep an AUTO-selected source in sync: adopt the engine's choice, but keep
  // an already-usable source selected until it becomes unavailable/insufficient,
  // at which point we re-evaluate and report the change. An explicit choice is
  // never touched here. Applying a new source is execution-relevant, so it goes
  // through `patchIntent` (bumps the version, discards the stale quote).
  useEffect(() => {
    if (state.intent.payTokenSource !== "recommended") return;
    if (!sourceSelection.sourceAsset) return;
    if (state.intent.payToken === sourceSelection.sourceAsset) return;
    // Keep the current auto-source while it is still executable + sufficient.
    const current = (optimizer?.options ?? []).find(
      (o) => o.symbol.toLowerCase() === state.intent.payToken.toLowerCase(),
    );
    if (state.intent.payToken && current?.ok && current.sufficient) return;
    const cfg = getToken(sourceSelection.sourceAsset);
    patchIntent({
      payToken: sourceSelection.sourceAsset,
      payTokenAddress: sourceSelection.sourceAddress ?? cfg?.address,
    });
  }, [
    sourceSelection,
    state.intent.payToken,
    state.intent.payTokenSource,
    optimizer,
    patchIntent,
  ]);

  // ---- Auto quote (debounced, version-guarded) ----------------------------
  // A slow request that resolves after the intent has moved on must never write
  // to state. Two guards enforce that: an AbortController and a request id that
  // is checked against the version the request was issued for.
  useEffect(() => {
    const intent = state.intent;
    if (!isQuotable(intent)) {
      setState((s) =>
        s.quote || s.quoting || s.quoteError
          ? { ...s, quote: null, quoting: false, quoteError: null }
          : s,
      );
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const issuedVersion = intent.version;
    const requestId = latestRef.current.issue(issuedVersion);

    setState((s) => ({ ...s, quoting: true, quoteError: null }));

    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...toPaymentIntent(intent),
            receiveTokenAddress: intent.receiveTokenAddress,
            payToken: intent.payToken,
            payTokenAddress: intent.payTokenAddress,
            network: intent.network,
          }),
          signal: controller.signal,
        });
        const json = await res.json();
        // Only the newest request for the current version may update the UI.
        if (controller.signal.aborted || !latestRef.current.isCurrent(requestId, issuedVersion)) return;
        setState((s) => {
          if (s.intent.version !== issuedVersion || !latestRef.current.isCurrent(requestId, issuedVersion)) return s;
          if (json.ok) {
            const q = json.quote as Quote;
            q.gasLimit = q.gasLimit ? (BigInt(q.gasLimit) as unknown as bigint) : undefined;
            q.gasPriceWei = q.gasPriceWei ? (BigInt(q.gasPriceWei) as unknown as bigint) : undefined;
            let learned = false;
            for (const t of [q.payToken, q.receiveToken, ...(q.route.tokens ?? [])]) {
              if (t?.address) {
                const before = getToken(t.symbol)?.address;
                registerToken(t);
                if (before?.toLowerCase() !== t.address.toLowerCase()) learned = true;
              }
            }
            return {
              ...s,
              quote: q,
              quoteVersion: issuedVersion,
              quoting: false,
              quoteError: null,
              autoRefreshAt: Date.now(),
              tokensVersion: learned ? s.tokensVersion + 1 : s.tokensVersion,
              intendedReceiveAmount:
                s.intent.amountMode === "i_spend"
                  ? q.receiveUsd.toFixed(2)
                  : s.intendedReceiveAmount,
            };
          }
          return {
            ...s,
            quote: null,
            quoteVersion: 0,
            quoting: false,
            quoteError: {
              code: json.code ?? "provider_error",
              message: json.message ?? "Could not build a quote.",
              alternatives: json.alternatives,
            },
          };
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        if (!latestRef.current.isCurrent(requestId, issuedVersion)) return;
        setState((s) => {
          if (s.intent.version !== issuedVersion) return s;
          return {
            ...s,
            quote: null,
            quoteVersion: 0,
            quoting: false,
            quoteError: { code: "provider_error", message: "Couldn't reach the routing service." },
          };
        });
      }
    }, 320);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [state.intent, nonce]);

  // ---- Live revalidation ---------------------------------------------------
  // A DEX continuously revalidates. Balances and gas eligibility are refreshed
  // on a timer while a wallet is connected; the composer consumes
  // `revalidationTick` to re-fetch balances.
  useEffect(() => {
    if (!state.walletAccount) return;
    const id = setInterval(
      () => setState((s) => ({ ...s, revalidationTick: s.revalidationTick + 1 })),
      REVALIDATE_INTERVAL_MS,
    );
    return () => clearInterval(id);
  }, [state.walletAccount]);

  // ---- Exact-payment protection -------------------------------------------
  const mismatch = useMemo(() => {
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
  // A quote is stale when it has aged out OR when it belongs to a previous
  // intent version. Either way execution is blocked until a fresh quote for the
  // current intent exists.
  const quoteStale =
    isQuoteStale(state.autoRefreshAt) || state.quoteVersion !== state.intent.version;

  // Proactively refresh as the quote approaches staleness (delay 0 when it has
  // already aged out, so a long-idle tab recovers immediately).
  useEffect(() => {
    if (!state.quote || !state.autoRefreshAt) return;
    const delay = Math.max(0, QUOTE_REFRESH_AFTER_MS - (Date.now() - state.autoRefreshAt));
    const timer = setTimeout(() => setNonce((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [state.quote, state.autoRefreshAt]);

  // ---- Balance sufficiency -------------------------------------------------
  const sufficiency = useMemo(() => {
    const q = state.quote;
    const bal = state.balances.find((b) => b.token.symbol === state.intent.payToken);
    if (!q || !bal) {
      return {
        status: "unknown" as const,
        required: q?.payAmount ?? "0",
        available: bal?.amount ?? "0",
        shortfall: "0",
      };
    }
    try {
      const required = parseUnits(q.payAmount, payTokenConfig.decimals);
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
      return {
        status: "unknown" as const,
        required: q.payAmount,
        available: bal.amount,
        shortfall: "0",
      };
    }
  }, [state.quote, state.balances, state.intent.payToken, payTokenConfig]);

  // ---- Partial-balance eligibility -----------------------------------------
  // A token-quantity intent ("send 100 NEWCOIN") may exceed what the wallet
  // holds. When another funded asset can cover the shortfall, the payment is
  // satisfiable by sending what is held and converting the rest. The exact
  // affordability is enforced by the signing guard against the fresh split; here
  // we only decide whether the split path is available at all.
  const partial = useMemo(() => {
    // A partial split only makes sense for a non-native target the wallet can
    // hold directly; the gas asset is never split.
    if (
      state.intent.amountMode !== "recipient_receives" ||
      !state.intent.receiveTokenAmount ||
      receiveTokenConfig.native
    ) {
      return null;
    }
    const targetAddr = (state.intent.receiveTokenAddress ?? receiveTokenConfig.address ?? "").toLowerCase();
    const held =
      state.balances.find(
        (b) =>
          !b.token.native &&
          ((b.token.address ?? "").toLowerCase() === targetAddr ||
            b.token.symbol.toLowerCase() === state.intent.receiveToken.toLowerCase()),
      )?.amount ?? "0";
    const split = splitPayment(state.intent.receiveTokenAmount, held, receiveTokenConfig.decimals);
    // Native MON is reserved for gas, so it is never spent covering a shortfall.
    const source = pickShortfallSource(
      state.balances
        .filter((b) => !b.token.native)
        .map((b) => ({
          symbol: b.token.symbol,
          address: b.token.address,
          usd: b.usd,
        })),
      targetAddr,
    );
    return {
      eligible: true,
      mode: split.mode,
      held: split.held,
      shortfall: split.shortfall,
      sourceSymbol: source?.symbol ?? null,
      covered: split.mode !== "direct" && Boolean(source),
    };
  }, [
    state.intent.amountMode,
    state.intent.receiveTokenAmount,
    state.intent.receiveTokenAddress,
    state.intent.receiveToken,
    state.balances,
    receiveTokenConfig,
  ]);

  // ---- Wallet abstraction state (partial, honest) --------------------------
  // Gas handling is per-payment, not a global boolean: whether abstraction is
  // available depends on the chain, the configured paymaster, the wallet's
  // advertised capability AND the selected asset.
  const abstraction = useMemo<AbstractionResult>(() => {
    const chainId = NETWORKS[state.intent.network].chainId;
    const supportedTokens: string[] = capabilities?.gas.supportedTokens ?? [];
    const paymasterConfigured = Boolean(capabilities?.gas.paymasterConfigured);
    return resolveAbstraction(payTokenConfig, {
      chainId,
      // Monad mainnet is the only configured chain today; it is supported when
      // the deployment targets it.
      chainSupported: state.intent.network === "mainnet",
      paymasterConfigured,
      // A policy is only usable within its window. `sponsorshipConfigured`
      // already folds in the window, so an expired policy is not abstracted.
      policyUsable: capabilities?.gas.sponsorshipConfigured ?? paymasterConfigured,
      policyReason: capabilities?.gas.policyReason,
      walletSupportsPaymaster: Boolean(walletGasCaps?.paymasterService),
      walletSupportsErc20Gas: Boolean(walletGasCaps?.erc20GasPayment),
      walletSupportsBatch: Boolean(walletGasCaps?.atomicBatch),
      supportedTokens,
    });
  }, [capabilities, walletGasCaps, payTokenConfig, state.intent.network]);

  // ---- Gas handling (abstracted when the wallet can actually deliver it) ---
  const gasInfo = useMemo<GasInfo>(() => {
    const paymasterConfigured = Boolean(capabilities?.gas.sponsorshipConfigured);
    const walletSupportsPaymaster = Boolean(walletGasCaps?.paymasterService);
    const walletSupportsErc20Gas = Boolean(walletGasCaps?.erc20GasPayment);

    // The ERC-20 paymaster path is selected ONLY from a live per-wallet
    // capability that the composer resolved from the provider + real balances —
    // never from a configured boolean. A configured provider with no funded
    // supported token is honestly "native".
    if (aaGas.available && aaGas.mode === "ERC20_PAYMASTER" && aaGas.tokenAddress) {
      return {
        mode: "erc20",
        paymasterConfigured: true,
        walletSupportsPaymaster,
        walletSupportsErc20Gas: true,
        erc20GasToken: aaGas.tokenSymbol ? { symbol: aaGas.tokenSymbol, address: aaGas.tokenAddress } : null,
        reason: aaGas.reason ?? null,
      };
    }

    // Alchemy Gas Manager sponsorship (a different, developer-sponsored model).
    if (abstraction.gasOptions.sponsored) {
      const pubKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
      const policyId = capabilities?.gas.policyId;
      return {
        mode: "sponsored",
        paymasterConfigured,
        walletSupportsPaymaster,
        walletSupportsErc20Gas,
        paymasterServiceUrl: pubKey ? alchemyPaymasterServiceUrl(pubKey) : undefined,
        paymasterContext: policyId ? { policyId } : undefined,
        reason: null,
      };
    }

    return {
      mode: "native",
      paymasterConfigured,
      walletSupportsPaymaster,
      walletSupportsErc20Gas,
      reason: aaGas.reason ?? abstraction.message ?? null,
    };
  }, [capabilities, walletGasCaps, abstraction, aaGas]);

  const gasSufficiency = useMemo(() => {
    const native = state.balances.find((b) => b.token.native);
    const availableMon = native?.amount ?? "0";
    if (gasInfo.mode !== "native") {
      return { status: "ok" as const, requiredMon: "0", availableMon };
    }
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
      const buffered = required + required / 5n;
      const available = parseUnits(availableMon, 18);
      if (available >= buffered) {
        return { status: "ok" as const, requiredMon: requiredMon.toFixed(6), availableMon };
      }
      return { status: "insufficient" as const, requiredMon: requiredMon.toFixed(6), availableMon };
    } catch {
      return { status: "unknown" as const, requiredMon: "0", availableMon };
    }
  }, [state.quote, state.balances, gasInfo]);

  // ---- Deterministic readiness gate ---------------------------------------
  // A source is "set" once it exists (explicitly chosen, fixed by the intent,
  // or auto-selected by the engine). The gate additionally surfaces a concrete
  // source-selection blocker, so "no executable source" is a specific error
  // rather than a generic "choose an asset".
  const payTokenIsSet = Boolean(state.intent.payToken);
  const readiness = useMemo(
    () =>
      computeReadiness({
        recipient: state.intent.recipient,
        recipientConfirmed,
        payTokenIsSet,
        sourceBlocked:
          state.balances.length === 0 || sourceSelection.pending
            ? null
            : sourceSelection.sourceAsset === null
              ? sourceSelection.blocker ?? sourceSelection.reason
              : sourceSelection.code === "explicit_unusable"
                ? sourceSelection.reason
                : null,
        payToken: state.intent.payToken,
        receiveToken: state.intent.receiveToken,
        quoting: state.quoting,
        // A quote from a previous intent version must never satisfy the gate.
        quote: state.quoteVersion === state.intent.version ? state.quote : null,
        quoteError: state.quoteError,
        quoteStale,
        sufficiency,
        gasSufficiency,
        mismatchActive: Boolean(mismatch?.active),
        partialCovered: Boolean(partial?.covered),
      }),
    [
      state.intent.recipient,
      state.intent.payToken,
      state.intent.receiveToken,
      sourceSelection,
      state.intent.version,
      state.quote,
      state.quoteVersion,
      state.quoteError,
      state.quoting,
      recipientConfirmed,
      payTokenIsSet,
      quoteStale,
      sufficiency,
      gasSufficiency,
      mismatch,
      partial,
    ],
  );

  const value: FlowContextValue = {
    ...state,
    setText,
    recipientConfirmed,
    markRecipientConfirmed: setRecipientConfirmed,
    setNetwork,
    setRecipient,
    setReceiveToken,
    setReceiveAmount,
    setAmountMode,
    setPayToken,
    patchIntent,
    setWalletAccount,
    setBalances,
    setBalancesLoading,
    addToken,
    refreshQuote,
    correctToIntended,
    applyNlIntent,
    recommendedPayToken,
    sourceSelection,
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
    gasMode: gasInfo.mode,
    gasInfo,
    partial,
    abstraction,
    setWalletGasCapabilities,
    aaGas,
    setAaGas,
    setGasPaymentToken,
    gasTokenConfig,
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
 * Resolve the canonical token for an intent asset: the contract address is
 * authoritative, the symbol is only a fallback. Returns `null` (never a
 * different token's config) when the asset cannot be resolved, so a label can
 * never be borrowed from an unrelated token.
 */
export function resolveIntentAsset(
  address: string | undefined,
  symbol: string,
): TokenConfig {
  if (address) {
    const byAddress = getTokenByAddress(address);
    if (byAddress) return byAddress;
  }
  if (symbol) {
    const bySymbol = getToken(symbol);
    if (bySymbol) return bySymbol;
  }
  // Unresolved: a neutral placeholder derived from the recorded symbol — never
  // another token's config, so the UI can't show a wrong asset's label.
  return {
    symbol: symbol || "—",
    name: symbol || "Unknown asset",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    native: false,
    fallbackUsd: 0,
    tint: tintForAddress(symbol || "unknown"),
    source: "wallet",
  };
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
