"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { formatAmount, formatUsd, isEvmAddress } from "@/lib/format";
import { nativeGasWarning } from "@/lib/domain/gasWarning";
import { usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet } from "@/lib/hooks/useWallet";
import { useTokenCatalog } from "@/lib/hooks/useTokenCatalog";
import { describePlan, buildPaymentPlan, buildPartialPlan } from "@/lib/execution/plan";
import { executePlan, executePlanBatched, ExecutionError, type StepResult } from "@/lib/execution/execute";
import { getWalletCapabilities, type WalletCapabilities } from "@/lib/execution/alchemy";
import { prepareSigning, type FreshPlan } from "@/lib/execution/signGuard";
import { executePlanViaAa, checkUserOperationReceipt, type AaExecutionResult } from "@/lib/aa/execution";
import { walletSupportsEip7702 } from "@/lib/aa/account";
import { useAaCapability } from "@/lib/hooks/useAaCapability";
import { displayKey } from "@/lib/domain/canonicalIntent";
import {
  buildPaymentDiagnostic,
  recordPaymentDiagnostic,
} from "@/lib/domain/paymentDiagnostics";
import { parseUnits } from "@/lib/domain/math";
import { normalizeTokenConfig, type TokenConfig } from "@/lib/config/tokens";
import { verifyDelivery, verifyDeliveryFromLogs } from "@/lib/execution/verify";
import { resolveExecutionProtection, type ExecutionProtection } from "@/lib/domain/protection";
import { getClientPublicClient } from "@/lib/wallet/clients";
import type { MonadNetwork } from "@/lib/config/chains";
import { NETWORKS } from "@/lib/config/chains";
import type { Balance, Quote, QuoteResult } from "@/lib/domain/intent";
import { Modal } from "@/components/ui/Modal";
import { TokenList } from "@/components/ui/TokenList";
import { RecipientField } from "./RecipientField";
import { AmountField } from "./AmountField";
import { PayAssetPicker } from "./PayAssetPicker";
import { ModeToggle } from "./ModeToggle";
import { IntentEngine } from "./IntentEngine";
import { MismatchAlert } from "./MismatchAlert";
import { LiveCalculation } from "./LiveCalculation";
import { FlowDiagram } from "@/components/flow/FlowDiagram";
import { ReviewSheet } from "./ReviewSheet";
import { SuccessScreen } from "@/components/success/SuccessScreen";
import { BalanceOverview } from "@/components/wallet/WalletBar";
import { Check, ChevronDown, Lock, Spinner, Warning } from "@/components/ui/Icons";
import { TokenBadge } from "@/components/ui/TokenBadge";

type Stage = "compose" | "review" | "executing" | "success";

/** Every confirmed/submitted hash a plan produced, in execution order. */
function hashOf(results: StepResult[]): `0x${string}`[] {
  return results
    .filter((r): r is StepResult & { hash: `0x${string}` } => Boolean(r.hash))
    .map((r) => r.hash);
}

export function PaymentComposer({ networkLabel }: { networkLabel: string }) {
  const flow = usePaymentFlow();
  const wallet = useWallet(flow.intent.network);
  const catalog = useTokenCatalog(flow.intent.network);
  const [stage, setStage] = useState<Stage>("compose");
  const [tokenModal, setTokenModal] = useState<null | "receive" | "pay">(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | undefined>();
  const [walletCaps, setWalletCaps] = useState<WalletCapabilities | null>(null);
  // Whether the wallet can sign an EIP-7702 UserOperation. Declared here, above
  // the capability effect that reports it into the flow. `null` ⇒ unknown.
  const [walletAaCompatible, setWalletAaCompatible] = useState<boolean | null>(null);
  const [delivery, setDelivery] = useState<
    { verified: boolean; delivered: string; expected: string; reason?: string } | null
  >(null);
  // Anchor the collected intent steps so a natural-language prefill can scroll
  // the user down to the fields it just filled.
  const composeRef = useRef<HTMLDivElement>(null);
  // The intent version the current Review was opened for. If the user edits the
  // intent, the review is no longer executable and we drop straight back to the
  // composer with a fresh computation.
  const reviewVersionRef = useRef<number | null>(null);
  // While a signing attempt is in flight, Review is pinned so a version bump the
  // engine performs mid-payment (a source re-pick, an account/revalidation
  // event) can never silently pop the user back to the composer. Cleared in the
  // attempt's `finally`, so a genuine change still ejects immediately after.
  const holdReviewRef = useRef(false);
  // A soft, non-ejecting message shown on Review when the intent legitimately
  // changed under the user (the safety backstop), so they know to review again.
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  // The last quote we actually displayed. When a refresh momentarily clears
  // `flow.quote` (a new version is being priced), we keep rendering the payment
  // from this instead of blanking the screen — the "interface disappeared"
  // symptom. It is only ever used for display; signing always re-quotes fresh.
  const lastQuoteRef = useRef<Quote | null>(null);
  // A UserOperation that was submitted but whose receipt we did not obtain
  // (a confirmation timeout). Retry must re-check this hash's status instead of
  // resubmitting — a second submission would double-spend the payment.
  const submittedUserOpRef = useRef<{
    hash: `0x${string}`;
    version: number;
    slippageBps: bigint;
    delivery: { verified: boolean; delivered: string; expected: string; reason?: string };
  } | null>(null);
  useEffect(() => {
    if (flow.quote) lastQuoteRef.current = flow.quote;
  }, [flow.quote]);

  // Ask the wallet what it supports (EIP-5792 atomic batch + paymaster). This
  // is what lets us offer sponsored / ERC-20 gas only when it can actually work.
  useEffect(() => {
    if (!wallet.provider) {
      setWalletCaps(null);
      flow.setWalletGasCapabilities(null);
      return;
    }
    let cancelled = false;
    getWalletCapabilities(wallet.provider, NETWORKS[flow.intent.network].chainId, wallet.address).then((caps) => {
      if (cancelled) return;
      setWalletCaps(caps);
      flow.setWalletGasCapabilities({
        atomicBatch: caps.atomicBatch,
        paymasterService: caps.paymasterService,
        erc20GasPayment: caps.erc20GasPayment,
        // The app's ERC-20 gas path is its own EIP-7702 UserOperation, which the
        // injected wallet signs — this does NOT need EIP-5792 `erc20GasPayment`.
        // `null` ⇒ unknown (never downgraded to "can't pay in an ERC-20").
        aaCapable: walletAaCompatible ?? true,
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.intent.network, wallet.provider, wallet.address, walletAaCompatible]);

  // Report the connected account to the flow. An account change invalidates
  // balances, gas eligibility and the whole transaction payload.
  useEffect(() => {
    flow.setWalletAccount(wallet.address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  // Whether the wallet can sign an EIP-7702 UserOperation. This is a browser
  // fact; the server capability is combined with it. Inconclusive ⇒ optimistic
  // (execution degrades cleanly on a rejection rather than blocking the user).
  useEffect(() => {
    let cancelled = false;
    if (!wallet.provider) {
      setWalletAaCompatible(null);
      return;
    }
    walletSupportsEip7702(wallet.provider as never, NETWORKS[flow.intent.network].chainId).then((ok) => {
      if (!cancelled) setWalletAaCompatible(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [wallet.provider, flow.intent.network]);

  // The live, per-wallet ERC-20 gas capability. Provider supported-set (server,
  // authoritative) ∩ real on-chain balances ∩ a live fee quote. This is what
  // decides honestly between "gas in an ERC-20" and "MON required". It re-fetches
  // on the revalidation tick so a balance/support change is reflected.
  const { capability: aaCapability } = useAaCapability(flow.intent.network, wallet.address, {
    explicitGasToken: flow.intent.gasPaymentTokenAddress ?? null,
    sourceSymbol: flow.intent.payToken ?? null,
    walletCompatible: walletAaCompatible ?? true,
    tick: flow.revalidationTick,
  });

  // Publish the resolved AA state to the flow so `gasInfo`/readiness agree with
  // what the review screen shows. Only a genuine ERC-20 selection is advertised.
  useEffect(() => {
    const wa = aaCapability?.walletAbstraction;
    if (!wa) {
      flow.setAaGas(null);
      return;
    }
    flow.setAaGas({
      available: wa.available && wa.mode === "ERC20_PAYMASTER",
      mode: wa.mode,
      tokenSymbol: wa.selectedGasToken?.symbol ?? null,
      tokenAddress: wa.selectedGasToken?.address ?? null,
      code: wa.code,
      reason: wa.available ? wa.reason : wa.reason ?? aaCapability?.selection.reason ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aaCapability]);

  // Live balances for a connected wallet. `revalidationTick` refreshes them
  // periodically so a DEX-like flow always shows current holdings.
  const { balances: liveBalances, loading: liveLoading } = useLiveBalances(
    wallet.address,
    flow.intent.network,
    flow.revalidationTick,
  );
  useEffect(() => {
    if (wallet.address) {
      flow.setBalances(liveBalances);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBalances, wallet.address]);

  // One signing attempt at a time. A double click (or a Retry tapped while the
  // first attempt is still preparing) must never run two overlapping
  // preparations — that is how duplicate submissions happen.
  const attemptRef = useRef(false);

  // A change to the canonical intent after Review normally invalidates the
  // review: the user must not sign a transaction for an older version. But a
  // version bump can also be produced by the *engine itself* while the user is
  // on Review (the optimizer re-picking a source, an account/revalidation
  // event). Ejecting on that is what silently returned the user to the previous
  // screen — the reported "Confirm → loading → previous screen" loop.
  //
  // Rules, in order:
  //   1. A quote momentarily absent because a refresh is in flight does NOT
  //      eject (Confirm/Retry stay gated by `quoteStale` until it lands).
  //   2. While a signing attempt is in flight, Review is pinned: a mid-payment
  //      version bump must not unmount the composer. The safety invariant is
  //      preserved by `prepareSigning`, which refuses to sign if the intent
  //      changed, rather than by ejecting the user.
  //   3. Otherwise, if the intent genuinely changed, keep the user on Review
  //      with a soft, recoverable notice — do NOT return to the composer. Their
  //      recipient/amount/assets are preserved; Review stays mounted and the
  //      new quote is shown as soon as it lands.
  useEffect(() => {
    if (stage !== "review") return;
    // A quote that already matches the current intent means nothing changed —
    // silently adopt the version (this is an engine re-price, e.g. the optimizer
    // re-picking a source) and stay on Review. A fresh quote also clears any
    // "details changed" notice, since the updated payment is now on screen.
    if (flow.quote && flow.quoteVersion === flow.intent.version) {
      reviewVersionRef.current = flow.intent.version;
      setReviewNotice((n) => (n ? null : n));
      return;
    }
    // A refresh is in flight: keep showing the last quote; Confirm stays gated.
    if (flow.quoting) return;
    // A signing attempt owns the screen until it resolves.
    if (holdReviewRef.current) return;
    // Otherwise the intent genuinely moved on with no fresh quote yet. Keep the
    // user on Review with a recoverable notice — never eject them to the
    // composer (the loop).
    const samePayment = reviewVersionRef.current === flow.intent.version;
    reviewVersionRef.current = flow.intent.version;
    setReviewNotice(
      samePayment
        ? "We couldn't refresh the price. Review the payment and try again."
        : "Your payment details were updated. Review the new quote and confirm again.",
    );
    if (!samePayment) {
      setSteps([]);
      setDelivery(null);
      setTxHash(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.intent.version, flow.quote, flow.quoteVersion, flow.quoting, stage]);

  // Routability is discovered, not hardcoded: in live mode we ask the routing
  // layer which tokens were actually probed and have a liquid route.
  const availability = useMemo(() => {
    const map: Record<string, boolean | null> = {};
    for (const t of catalog.tokens) {
      if (typeof t.routable === "boolean") map[t.symbol] = t.routable;
    }
    return map;
  }, [catalog.tokens]);

  const recipientValid = isEvmAddress(flow.intent.recipient);
  const recipientConfirmed = flow.recipientConfirmed && recipientValid;
  const canContinue = flow.readiness.ready;

  // The quote the Review renders. While a refresh is in flight (or a genuine
  // change is being re-priced) `flow.quote` can be momentarily null; we keep
  // showing the last quote so the payment never blanks, and gate Confirm on
  // freshness so a stale figure is never signed.
  const reviewQuote = flow.quote ?? lastQuoteRef.current;
  const quoteFreshForCurrentIntent =
    flow.quoteVersion === flow.intent.version && Boolean(flow.quote);

  // The execution-safety surface for the current quote: MEV capability,
  // slippage tolerance, and the price-impact assessment. Derived from real
  // configuration + the live quote, never from a hardcoded badge.
  const protection: ExecutionProtection | null = useMemo(
    () =>
      reviewQuote
        ? resolveExecutionProtection(reviewQuote.priceImpact)
        : null,
    [reviewQuote],
  );

  // A token-quantity intent that the wallet only partly holds is satisfied by a
  // split (send the held amount + convert the shortfall). The guard rebuilds
  // and re-protects both legs from fresh data. Only when the flow has resolved
  // that a funded source can cover the shortfall do we take the split path;
  // otherwise a normal (or insufficient) payment is handled as before.
  const partialEligible = partialEligibleFor(flow.intent) && flow.partial?.covered === true;

  // A descriptive plan for display only; the *signed* plan is rebuilt fresh
  // inside the signing guard from the current intent.
  const displayPlan = useMemo(() => {
    if (!reviewQuote) return { steps: [], primaryStepId: "", executable: false, slippageBps: 0 };
    try {
      return buildPaymentPlan(
        reviewQuote,
        (wallet.address ?? flow.intent.recipient) as `0x${string}`,
        flow.intent.recipient as `0x${string}`,
      );
    } catch {
      return { steps: [], primaryStepId: "", executable: false, slippageBps: 0 };
    }
  }, [reviewQuote, flow.intent.recipient, wallet.address]);

  // Keep the latest intent reachable from inside the async guard so the
  // version check reads the *current* value, not the one captured at render.
  const intentRef = useRef(flow.intent);
  useEffect(() => {
    intentRef.current = flow.intent;
  }, [flow.intent]);

  // The live wallet account, so the guard can detect an account switch during
  // transaction preparation.
  const accountRef = useRef(wallet.address);
  useEffect(() => {
    accountRef.current = wallet.address;
  }, [wallet.address]);

  const onReview = useCallback(() => {
    if (!flow.readiness.ready || !flow.quote) return;
    setError(null);
    setReviewNotice(null);
    reviewVersionRef.current = flow.intent.version;
    setStage("review");
  }, [flow.readiness.ready, flow.quote, flow.intent.version]);

  const reset = useCallback(() => {
    setStage("compose");
    reviewVersionRef.current = null;
    setSteps([]);
    setError(null);
    setReviewNotice(null);
    setTxHash(undefined);
    setDelivery(null);
    lastQuoteRef.current = null;
    submittedUserOpRef.current = null;
    flow.refreshQuote();
  }, [flow]);

  /**
   * Signing safety pipeline. Immediately before the wallet is asked to sign we
   * build a FRESH transaction from the CURRENT intent and fresh live data, and
   * prove the intent did not change while we were preparing. Calldata is never
   * reused from an earlier build.
   */
  const onConfirm = useCallback(async () => {
    // A second attempt while the first is still preparing would run two
    // overlapping preparations. Refuse it rather than submit twice.
    if (attemptRef.current) return;
    attemptRef.current = true;
    // Pin Review for the whole attempt: a version bump the engine performs
    // mid-payment must not eject the user (the loop). Cleared in `finally`.
    holdReviewRef.current = true;
    setError(null);
    setReviewNotice(null);
    setSteps([]);
    setDelivery(null);

    // Structured, secret-free trail: every failure records the exact stage so
    // the "returns to Confirm and Send with no explanation" symptom can be
    // attributed instead of guessed. Console-only; never sent to a server.
    recordPaymentDiagnostic(buildPaymentDiagnostic({ event: "payment_submit_started" }));

    try {
      if (!wallet.address || !wallet.walletClient) {
        setError("Connect your wallet to pay on Monad.");
        recordPaymentDiagnostic(
          buildPaymentDiagnostic({
            event: "payment_failed",
            code: "no_wallet",
            message: "Connect your wallet to pay on Monad.",
            returnedToConfirm: true,
          }),
        );
        return;
      }
      recordPaymentDiagnostic(buildPaymentDiagnostic({ event: "wallet_connection_checked" }));

      const onChain = await wallet.ensureMonad();
      if (!onChain.ok) {
        // Show the wallet's REAL reason (rejection vs unsupported vs transient)
        // rather than a blanket "switch to Monad", and record which it was.
        const { error } = onChain;
        setError(error.message);
        recordPaymentDiagnostic(
          buildPaymentDiagnostic({
            event: "payment_failed",
            code: `chain_${error.kind}`,
            message: error.message,
            walletRejected: error.rejected,
            returnedToConfirm: true,
          }),
        );
        return;
      }
      recordPaymentDiagnostic(buildPaymentDiagnostic({ event: "chain_validation_completed" }));

      setStage("executing");

      // A previously-submitted-but-unconfirmed UserOperation owns Retry: never
      // resubmit it. Re-check its real receipt instead. This is the path that
      // previously left the user looping on "Waiting for confirmation…" with no
      // way to learn the true outcome, and risks a double submission. It runs
      // before the freshness gate because confirming a submitted payment must
      // never be blocked by a quote that expired during the wait.
      const pending = submittedUserOpRef.current;
      if (pending) {
        // If the intent moved on since the submission, the pending hash belongs
        // to a different payment — stop treating it as this payment's operation.
        if (pending.version !== flow.intent.version) {
          submittedUserOpRef.current = null;
        } else {
          const receipt = await checkUserOperationReceipt(
            getClientPublicClient(flow.intent.network),
            flow.intent.network,
            pending.hash,
          );
          submittedUserOpRef.current = null;
          if (receipt?.success) {
            const check = verifyDeliveryFromLogs(
              receipt.logs,
              flow.receiveTokenConfig,
              flow.intent.recipient,
              pending.delivery.expected,
              pending.slippageBps,
            );
            setDelivery(check);
            setTxHash(receipt.transactionHash ?? pending.hash);
            recordPaymentDiagnostic(
              buildPaymentDiagnostic({
                event: "payment_execution_verified",
                hasUserOpHash: true,
                hasTransactionHash: Boolean(receipt.transactionHash),
              }),
            );
            setStage("success");
          } else if (receipt) {
            setDelivery({ ...pending.delivery, verified: false, reason: receipt.reason ?? "the transaction reverted" });
            setError(receipt.reason ?? "The payment reverted on-chain and was not delivered.");
            recordPaymentDiagnostic(
              buildPaymentDiagnostic({
                event: "payment_failed",
                code: "op_reverted",
                message: receipt.reason ?? "the transaction reverted",
                hasUserOpHash: true,
                returnedToConfirm: true,
              }),
            );
            setStage("review");
          } else {
            // Still unresolved: tell the truth and let the user check again.
            submittedUserOpRef.current = pending;
            setError(
              "This payment was already submitted and is still awaiting confirmation. It was not resubmitted — use Retry to check its status again.",
            );
            recordPaymentDiagnostic(
              buildPaymentDiagnostic({
                event: "user_operation_pending",
                code: "receipt_not_available",
                hasUserOpHash: true,
                mayHaveSubmitted: true,
                returnedToConfirm: true,
              }),
            );
            setStage("review");
          }
          return;
        }
      }

      // The approval gate evaluates the CURRENT intent only. It runs after the
      // pending re-check so it never blocks confirming a submitted payment.
      if (!flow.readiness.ready) {
        flow.refreshQuote();
        setError("This payment changed. Review it again before confirming.");
        recordPaymentDiagnostic(
          buildPaymentDiagnostic({
            event: "payment_failed",
            code: `readiness_${flow.readiness.code}`,
            message: "This payment changed. Review it again before confirming.",
            returnedToConfirm: true,
          }),
        );
        return;
      }

      // Track locally whether any submission was attempted: an ambiguous batch
      // failure must not be retried sequentially, even before React state lands.
      let sawSubmission = false;
      const onStep = (r: StepResult) => {
        if (r.status === "submitted" || r.hash) sawSubmission = true;
        setSteps((prev) => {
          const idx = prev.findIndex((x) => x.stepId === r.stepId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = r;
            return copy;
          }
          return [...prev, r];
        });
      };

      try {
      // --- Fresh intent build, immediately before signing -------------------
        const prepared = await prepareSigning(
          {
            intent: flow.intent,
            sender: wallet.address,
            recipient: flow.intent.recipient as `0x${string}`,
            // The clamped tolerance encoded into the on-chain swap bound.
            slippageBps: protection?.slippage.bps,
            // Proof the payment the user is looking at is the canonical intent.
            displayedKey: displayKey(flow.intent),
          },
          {
            fetchBalances: () => fetchBalances(wallet.address!, flow.intent.network),
            fetchQuote: (intent) => fetchQuote(intent),
            // A partial-balance payment has two legs; the guard asks the partial
            // planner to rebuild both from the fresh balances and applies every
            // protection (freshness, price impact, per-leg on-chain bounds).
            ...(partialEligible
              ? {
                  fetchPlan: async (intent, balances) =>
                    fetchPartialPlan(
                      intent,
                      balances,
                      wallet.address!,
                      flow.receiveTokenConfig.symbol,
                      protection?.slippage.bps,
                    ),
                  covers: (balances, plan) => coversPartialPlan(balances, plan),
                }
              : {}),
            resolveGas: async () => flow.gasInfo.mode,
            readGas: async () => ({
              gasLimit: flow.quote?.gasLimit,
              gasPriceWei: flow.quote?.gasPriceWei,
            }),
            // Re-resolve the ERC-20 gas payment right before signing: the wallet
            // must still hold the gas token and still be AA-compatible. Losing it
            // between review and signing blocks the signature.
            readGasPayment: async () => {
              const wa = aaCapability?.walletAbstraction;
              const token = wa?.selectedGasToken;
              if (!token) return { mode: flow.gasInfo.mode as "native" | "erc20" | "sponsored" };
              const balance = aaCapability?.supportedGasTokens.find(
                (t) => t.address.toLowerCase() === token.address.toLowerCase(),
              );
              const decimals = token.decimals;
              const estimate =
                token.estimatedFee && Number.isFinite(Number(token.estimatedFee))
                  ? parseUnits(token.estimatedFee, decimals)
                  : undefined;
              const gasTokenBalance = balance ? parseUnits(balance.balance, decimals) : undefined;
              return {
                mode: wa?.mode === "ERC20_PAYMASTER" ? ("erc20" as const) : ("native" as const),
                gasToken: { address: token.address, decimals, symbol: token.symbol },
                gasTokenBalance,
                gasEstimate: estimate,
              };
            },
            readIntent: () => intentRef.current,
            readAccount: () => accountRef.current,
          },
        );

        if (!prepared.ok) {
          // The review stays inside the payment flow: the quote/plan was rebuilt
          // from fresh data and the guard refused to sign for a specific reason
          // (a moved price, a changed balance). We surface a recoverable error and
          // refresh the quote so the user can retry the same review, rather than
          // dropping them back to a blank composer.
          setError(prepared.message);
          recordPaymentDiagnostic(
            buildPaymentDiagnostic({
              // `prepareSigning` refuses before any signature/submission, so the
              // failing stage is operation preparation.
              event: "payment_failed",
              code: prepared.reason,
              message: prepared.message,
              returnedToConfirm: true,
            }),
          );
          setStage("review");
          flow.refreshQuote();
          return;
        }

        const plan = prepared.plan;

        let primaryHash: `0x${string}` | undefined;
        let stepHashes: `0x${string}`[] = [];
        let aaResult: AaExecutionResult | null = null;

        // --- ERC-20 gas path (EIP-7702 + paymaster) --------------------------
        // When gas is paid in a token, the payment MUST execute as one atomic
        // UserOperation so the paymaster can settle the fee. This is a genuinely
        // different submission path from the sequential EOA path below, not a
        // relabelling: an EOA transaction cannot carry a paymaster.
        if (prepared.gasMode === "erc20" && flow.gasInfo.erc20GasToken && wallet.provider) {
          // Bound the paymaster allowance against the user's real gas-token
          // balance — the approval is never unlimited.
          const gasTokenView = aaCapability?.supportedGasTokens.find(
            (t) => t.address.toLowerCase() === flow.gasInfo.erc20GasToken!.address.toLowerCase(),
          );
          const gasTokenBalance = gasTokenView
            ? parseUnits(gasTokenView.balance, gasTokenView.decimals)
            : undefined;
          aaResult = await executePlanViaAa(
            plan,
            wallet.provider as never,
            wallet.address,
            flow.intent.network,
            flow.gasInfo.erc20GasToken.address as `0x${string}`,
            getClientPublicClient(flow.intent.network),
            onStep,
            gasTokenBalance,
            // Stage observer: records the exact stage reached (authorization →
            // preparation → paymaster → bundler → receipt) so a failure can be
            // attributed, never guessed.
            (stage) => recordPaymentDiagnostic(buildPaymentDiagnostic({ event: stage })),
          );
          primaryHash = aaResult.transactionHash ?? aaResult.userOpHash;
          stepHashes = aaResult.transactionHash ? [aaResult.transactionHash] : [];
          setTxHash(primaryHash);

          // Submitted but not yet confirmed: record the hash so Retry re-checks
          // its status instead of resubmitting, and keep Review mounted with the
          // real reason. It is neither success nor failure.
          if (aaResult.unconfirmed) {
            submittedUserOpRef.current = {
              hash: aaResult.userOpHash,
              version: flow.intent.version,
              slippageBps: BigInt(prepared.plan.slippageBps),
              delivery: {
                verified: false,
                delivered: "0",
                expected: prepared.quote.receiveAmount,
                reason: "the transaction was submitted but is not confirmed yet",
              },
            };
            setDelivery(null);
            setError(
              "The transaction was submitted but Monad hasn't confirmed it yet. It was not resubmitted — Retry to check its status again.",
            );
            setStage("review");
            return;
          }

          // A reverted UserOperation is a failed payment — never reported success.
          if (!aaResult.success) {
            setDelivery({
              verified: false,
              delivered: "0",
              expected: prepared.quote.receiveAmount,
              reason: aaResult.reason ?? "the transaction reverted",
            });
            setError(aaResult.reason ?? "The payment reverted on-chain and was not delivered.");
            setStage("review");
            return;
          }

          // Prove the recipient actually received the token from the real receipt
          // logs — the UserOperation's success flag alone is not delivery.
          const check = verifyDeliveryFromLogs(
            aaResult.logs,
            flow.receiveTokenConfig,
            flow.intent.recipient,
            prepared.quote.receiveAmount,
            BigInt(prepared.plan.slippageBps),
          );
          setDelivery(check);
          recordPaymentDiagnostic(
            buildPaymentDiagnostic({
              event: "payment_execution_verified",
              hasUserOpHash: true,
              hasTransactionHash: Boolean(aaResult.transactionHash),
            }),
          );
          setStage("success");
          return;
        }

        // Prefer an atomic EIP-5792 batch when the wallet supports it and the plan
        // needs more than one step, or when gas is abstracted (a single-step
        // payment must still go through `wallet_sendCalls` for a paymaster to
        // sponsor it).
        const useBatch =
          plan.executable &&
          Boolean(wallet.provider) &&
          Boolean(walletCaps?.atomicBatch) &&
          (plan.steps.length > 1 || prepared.gasMode !== "native");

        if (useBatch) {
          try {
            const result = await executePlanBatched(
              plan,
              wallet.provider!,
              wallet.address,
              NETWORKS[flow.intent.network].chainId,
              flow.intent.network,
              {
                paymasterServiceUrl: flow.gasInfo.paymasterServiceUrl,
                paymasterContext: flow.gasInfo.paymasterContext,
                erc20GasPayment: prepared.gasMode === "erc20",
              },
              { onStep },
            );
            primaryHash = result.primaryHash;
            stepHashes = hashOf(result.results);
          } catch (batchErr) {
            if (batchErr instanceof ExecutionError && batchErr.code === "rejected") throw batchErr;
            // If the batch already produced a transaction hash (pre- or
            // post-confirmation), the submission is ambiguous or done. Never fire
            // a second, sequential submission for it — that would double-submit.
            if (
              (batchErr instanceof ExecutionError && batchErr.code === "submitted") ||
              sawSubmission ||
              stepHashes.length > 0
            ) {
              throw batchErr;
            }
            const result = await executePlan(plan, wallet.walletClient, flow.intent.network, { onStep });
            primaryHash = result.primaryHash;
            stepHashes = hashOf(result.results);
          }
        } else {
          const result = await executePlan(plan, wallet.walletClient, flow.intent.network, { onStep });
          primaryHash = result.primaryHash;
          stepHashes = hashOf(result.results);
        }

        setTxHash(primaryHash);

        recordPaymentDiagnostic(
          buildPaymentDiagnostic({
            event: "receipt_polling_started",
            hasTransactionHash: Boolean(primaryHash),
          }),
        );

        const hashes = stepHashes.length ? stepHashes : primaryHash ? [primaryHash] : [];
        if (hashes.length) {
          try {
            const check = await verifyDelivery(
              getClientPublicClient(flow.intent.network),
              hashes,
              flow.receiveTokenConfig,
              flow.intent.recipient,
              prepared.quote.receiveAmount,
              // Use the tolerance the transaction actually enforced on-chain, so
              // a legitimate fill is never reported as unverified.
              BigInt(prepared.plan.slippageBps),
            );
            setDelivery(check);
          } catch {
            setDelivery(null);
          }
        }

        // A native-path payment only reaches `success` after its receipt(s) were
        // fetched and delivery was verified; the UserOperation path returns above.
        recordPaymentDiagnostic(
          buildPaymentDiagnostic({
            event: "payment_execution_verified",
            hasTransactionHash: hashes.length > 0,
          }),
        );
        setStage("success");
      } catch (err) {
        const message =
          err instanceof ExecutionError ? err.message : "The payment could not be completed.";
        const code = err instanceof ExecutionError ? err.code : "unknown";
        setError(message);
        // A definite pre-submission outcome (rejection/revert) or an ambiguous
        // post-submission one both return to Review — never silently to compose.
        // The recipient, amount and selected asset are preserved in the intent.
        recordPaymentDiagnostic(
          buildPaymentDiagnostic({
            event: "payment_failed",
            code,
            message,
            // `submitted` is the only code that means the operation may already
            // be on-chain and must not be blindly retried.
            mayHaveSubmitted: code === "submitted" || sawSubmission,
            returnedToConfirm: true,
          }),
        );
        setStage("review");
      }
    } finally {
      attemptRef.current = false;
      holdReviewRef.current = false;
      // Re-anchor Review to whatever version the intent now holds (read live,
      // not from the captured render), so a source re-pick the engine performed
      // during the attempt does not immediately re-trigger the invalidation
      // effect after the hold is released.
      reviewVersionRef.current = intentRef.current.version;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    flow.intent,
    flow.readiness.ready,
    flow.receiveTokenConfig,
    flow.gasInfo,
    flow.refreshQuote,
    protection,
    wallet.address,
    wallet.walletClient,
    wallet.provider,
    wallet.ensureMonad,
    walletCaps,
    aaCapability,
  ]);

  return (
    <div className="card overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-mono shadow-[0_0_10px_2px_rgba(131,110,249,0.6)]" />
          <span className="text-sm font-semibold text-white">Payment</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="chip text-emerald-200/80">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live · {networkLabel}
          </span>
          <span className="chip text-white/45" title="Canonical intent version">
            v{flow.intent.version}
          </span>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {stage === "compose" && (
          <motion.div
            key="compose"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="grid gap-5 p-5 sm:grid-cols-[1.05fr_0.95fr] sm:gap-6 sm:p-6"
          >
            <div className="sm:col-span-2">
              <IntentEngine
                onPrefilled={() =>
                  composeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              />
            </div>

            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="sm:col-span-2 flex items-start gap-2 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-3.5 text-xs text-amber-100"
                >
                  <Warning className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {/* left: intent */}
            <div ref={composeRef} className="min-w-0 scroll-mt-24 space-y-4">
              <Step n={1}>
                <RecipientField
                  value={flow.intent.recipient}
                  onChange={flow.setRecipient}
                  onValidChange={(valid) => flow.markRecipientConfirmed(valid)}
                />
              </Step>

              <Step n={2} title={flow.intent.amountMode === "i_spend" ? "How much will you spend?" : "What should they receive?"}>
                <ModeToggle value={flow.intent.amountMode} onChange={flow.setAmountMode} />
                <div className="mt-3 space-y-2">
                  {(() => {
                    const iSpend = flow.intent.amountMode === "i_spend";
                    // The amount is USD-denominated in both modes, but the token
                    // badge must reflect the *side* the amount is expressed in:
                    // "recipient receives" prices the output asset, "I spend"
                    // prices the input asset. Showing the output asset next to a
                    // spend amount is what produced "You spend exactly $5 in
                    // AUSD" while the real pay asset was USDT.
                    const amountToken = iSpend ? flow.payTokenConfig : flow.receiveTokenConfig;
                    return (
                      <AmountField
                        amount={flow.intent.receiveAmount}
                        onAmountChange={flow.setReceiveAmount}
                        token={amountToken}
                        onOpenToken={() => setTokenModal(iSpend ? "pay" : "receive")}
                        label={iSpend ? "I spend" : "Recipient receives"}
                        usdHint={
                          iSpend
                            ? `You spend exactly ${formatUsd(Number(flow.intent.receiveAmount || "0"))} in ${amountToken.symbol}`
                            : `They get exactly ${formatUsd(Number(flow.intent.receiveAmount || "0"))} in ${amountToken.symbol}`
                        }
                      />
                    );
                  })()}

                  {/* In "I spend" mode the amount badge is the *pay* asset, so
                      the output asset needs its own, explicit chooser. */}
                  {flow.intent.amountMode === "i_spend" && (
                    <button
                      onClick={() => setTokenModal("receive")}
                      className="flex w-full items-center justify-between rounded-2xl border border-white/[0.08] bg-ink-900/40 px-3 py-2.5 transition hover:border-white/20 hover:bg-white/[0.04]"
                      aria-label="Choose receive token"
                    >
                      <span className="text-xs text-white/45">They receive</span>
                      <span className="flex items-center gap-2">
                        <TokenBadge token={flow.receiveTokenConfig} size={22} />
                        <span className="text-sm font-semibold text-white">
                          {flow.receiveTokenConfig.symbol}
                        </span>
                        <ChevronDown className="h-4 w-4 text-white/50" />
                      </span>
                    </button>
                  )}
                </div>
              </Step>

              <Step n={3}>
                <PayAssetPicker
                  balances={flow.balances}
                  selected={flow.intent.payToken || flow.sourceSelection.sourceAsset || ""}
                  payTokenIsSet={
                    flow.intent.payTokenSource === "user" || flow.intent.payTokenSource === "intent"
                  }
                  recommended={flow.recommendedPayToken}
                  reason={
                    flow.sourceSelection.sourceAsset || flow.sourceSelection.pending
                      ? flow.sourceSelection.reason
                      : undefined
                  }
                  availability={availability}
                  catalog={catalog.tokens}
                  network={flow.intent.network}
                  onAddToken={flow.addToken}
                  optimizer={flow.optimizer}
                  optimizerLoading={flow.optimizerLoading}
                  onSelect={(s, address) => flow.setPayToken(s, true, address)}
                />
              </Step>

              <AnimatePresence>
                {flow.mismatch?.active && (
                  <MismatchAlert
                    intended={flow.mismatch.intended}
                    current={flow.mismatch.current}
                    difference={flow.mismatch.difference}
                    onCorrect={flow.correctToIntended}
                  />
                )}
              </AnimatePresence>

              {flow.sufficiency.status === "insufficient" && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 rounded-2xl border border-red-400/25 bg-red-500/[0.07] p-3.5 text-xs text-red-200"
                >
                  <Warning className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {`Not enough ${flow.intent.payToken}. You need ${formatAmount(flow.sufficiency.required)} ${flow.intent.payToken} but hold ${formatAmount(flow.sufficiency.available)}. Short by ${formatAmount(flow.sufficiency.shortfall)} ${flow.intent.payToken}.`}
                  </span>
                </motion.div>
              )}

              {flow.sufficiency.status !== "insufficient" &&
                flow.gasSufficiency.status === "insufficient" &&
                (() => {
                  // Never word this as a MON demand while the same screen offers
                  // an ERC-20 gas path — that contradiction is the reported bug.
                  const g = nativeGasWarning({
                    requiredMon: formatAmount(flow.gasSufficiency.requiredMon),
                    availableMon: formatAmount(flow.gasSufficiency.availableMon),
                    erc20GasOffered: flow.abstraction.gasOptions.erc20GasPayment,
                    reason: flow.abstraction.gasOptions.erc20GasPayment
                      ? flow.abstraction.message
                      : null,
                  });
                  return (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-2 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-3.5 text-xs text-amber-100"
                    >
                      <Warning className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{`${g.title}. ${g.detail}`}</span>
                    </motion.div>
                  );
                })()}
            </div>

            {/* right: live result */}
            <div className="min-w-0 space-y-4">
              <FlowDiagram
                quote={flow.quote}
                payToken={flow.payTokenConfig}
                receiveToken={flow.receiveTokenConfig}
                recipient={flow.intent.recipient}
                recipientValid={recipientConfirmed}
              />

              <LiveCalculation
                quote={flow.quote}
                quoting={flow.quoting}
                error={flow.quoteError}
                payToken={flow.payTokenConfig}
                receiveToken={flow.receiveTokenConfig}
                readiness={flow.readiness}
                onUseAlternative={(s) => {
                  flow.setReceiveToken(s);
                }}
              />

              <BalanceOverview
                balances={flow.balances}
                loading={liveLoading}
                connected={Boolean(wallet.address)}
              />

              <button
                onClick={onReview}
                disabled={!canContinue}
                className="btn-primary w-full"
                aria-disabled={!canContinue}
              >
                {flow.readiness.code === "quoting" || flow.readiness.code === "quote_stale" ? (
                  <>
                    <Spinner className="h-4 w-4 animate-spin" /> {flow.readiness.cta}
                  </>
                ) : flow.readiness.ready ? (
                  <>
                    <Lock className="h-4 w-4" /> {flow.readiness.cta}
                  </>
                ) : (
                  flow.readiness.cta
                )}
              </button>
            </div>
          </motion.div>
        )}

        {stage === "review" && reviewQuote && (
          <motion.div
            key="review"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-h-[80vh] overflow-hidden"
          >
            <ReviewSheet
              quote={reviewQuote}
              payToken={flow.payTokenConfig}
              receiveToken={flow.receiveTokenConfig}
              recipient={flow.intent.recipient}
              planSteps={describePlan(displayPlan)}
              onConfirm={onConfirm}
              onBack={() => {
                setStage("compose");
                reviewVersionRef.current = null;
              }}
              onRetry={onConfirm}
              onRefresh={flow.refreshQuote}
              confirming={false}
              error={error}
              notice={reviewNotice}
              canConfirm={quoteFreshForCurrentIntent && !flow.quoteStale && flow.readiness.ready}
              networkLabel={networkLabel}
              gasMode={flow.gasMode}
              batchable={Boolean(walletCaps?.atomicBatch)}
              quotedAt={reviewQuote.quotedAt}
              quoteStale={flow.quoteStale}
              protection={protection}
              gasInfo={flow.gasInfo}
              supportedGasTokens={aaCapability?.supportedGasTokens}
              onSelectGasToken={(address) => {
                if (!address) {
                  flow.setGasPaymentToken(null);
                  return;
                }
                const t = aaCapability?.supportedGasTokens.find(
                  (x) => x.address.toLowerCase() === address.toLowerCase(),
                );
                if (t) flow.setGasPaymentToken({ symbol: t.symbol, address: t.address });
              }}
              partial={
                flow.partial && flow.partial.mode !== "direct"
                  ? {
                      mode: flow.partial.mode,
                      held: flow.partial.held,
                      shortfall: flow.partial.shortfall,
                      sourceSymbol: flow.partial.sourceSymbol,
                    }
                  : null
              }
            />
          </motion.div>
        )}

        {stage === "executing" && (
          <motion.div
            key="executing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center px-6 py-16 text-center"
          >
            <div className="relative mb-5 flex h-16 w-16 items-center justify-center">
              <span className="absolute inset-0 rounded-full bg-mono/30 animate-pulseRing" />
              <Spinner className="h-10 w-10 animate-spin text-mono-soft" />
            </div>
            <h3 className="text-lg font-semibold text-white">Waiting for confirmation…</h3>
            <p className="mt-1 max-w-xs text-sm text-white/45">
              Approve each step in your wallet. Confirmation usually takes under a second on Monad.
            </p>
            {steps.length > 0 && (
              <div className="mt-6 w-full max-w-sm space-y-2 text-left">
                {steps.map((s) => (
                  <div key={s.stepId} className="flex items-center gap-2 text-xs">
                    {s.status === "confirmed" ? (
                      <Check className="h-4 w-4 text-emerald-300" />
                    ) : s.status === "failed" ? (
                      <Warning className="h-4 w-4 text-red-300" />
                    ) : s.status === "submitted" ? (
                      <Spinner className="h-4 w-4 animate-spin text-mono-soft" />
                    ) : (
                      <span className="h-4 w-4 rounded-full border border-white/20" />
                    )}
                    <span className="text-white/65">{s.label}</span>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {stage === "success" && reviewQuote && (
          <motion.div key="success" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-h-[85vh] overflow-y-auto">
            <SuccessScreen
              payToken={flow.payTokenConfig}
              receiveToken={flow.receiveTokenConfig}
              payAmount={reviewQuote.payAmount}
              payUsd={reviewQuote.payUsd}
              receiveAmount={reviewQuote.receiveAmount}
              receiveUsd={reviewQuote.receiveUsd}
              recipient={flow.intent.recipient}
              txHash={txHash}
              network={flow.intent.network}
              onReset={reset}
              delivery={delivery}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* token modals */}
      <Modal open={tokenModal === "receive"} onClose={() => setTokenModal(null)} title="Recipient receives">
        <TokenList
          tokens={catalog.tokens}
          balances={flow.balances}
          selected={flow.intent.receiveToken}
          availability={availability}
          network={flow.intent.network}
          onAddToken={flow.addToken}
          onSelect={(s, address) => {
            flow.setReceiveToken(s, address);
            setTokenModal(null);
          }}
        />
      </Modal>
      <Modal open={tokenModal === "pay"} onClose={() => setTokenModal(null)} title="Pay with">
        <TokenList
          tokens={catalog.tokens}
          balances={flow.balances}
          selected={flow.intent.payToken}
          availability={availability}
          network={flow.intent.network}
          onAddToken={flow.addToken}
          prefer="pay"
          onSelect={(s, address) => {
            flow.setPayToken(s, true, address);
            setTokenModal(null);
          }}
        />
      </Modal>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <div className="mb-2 flex items-center gap-2">
        <span className="num flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-white/60">
          {n}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/35">
          {title ?? (n === 1 ? "Recipient" : n === 2 ? "What should they receive?" : "How will you pay?")}
        </span>
      </div>
      {children}
    </div>
  );
}

/** Read fresh balances from the chain for the signing guard. */
async function fetchBalances(address: string, network: MonadNetwork): Promise<Balance[]> {
  const res = await fetch(`/api/balances?address=${address}&network=${network}`, { cache: "no-store" });
  const json = await res.json();
  return json.ok ? (json.balances as Balance[]) : [];
}

/** Re-run the full quote pipeline for the signing guard. */
async function fetchQuote(intent: {
  recipient: string;
  receiveToken: string;
  receiveAmount: string;
  amountMode: string;
  payToken: string;
  network: MonadNetwork;
}): Promise<QuoteResult> {
  const res = await fetch("/api/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveAmount: intent.receiveAmount,
      amountMode: intent.amountMode,
      payToken: intent.payToken,
      network: intent.network,
    }),
  });
  const json = await res.json();
  if (!json.ok) return { ok: false, code: json.code ?? "provider_error", message: json.message ?? "Could not build a quote." };
  const q = json.quote;
  q.gasLimit = q.gasLimit ? (BigInt(q.gasLimit) as unknown as bigint) : undefined;
  q.gasPriceWei = q.gasPriceWei ? (BigInt(q.gasPriceWei) as unknown as bigint) : undefined;
  return { ok: true, quote: q };
}

// ---------------------------------------------------------------------------
// Partial-balance payment ("send what you hold + obtain the rest")
// ---------------------------------------------------------------------------

/** True when the current intent can be satisfied by a partial split. */
export function partialEligibleFor(intent: {
  receiveTokenAmount?: string;
  amountMode: string;
}): boolean {
  return intent.amountMode === "recipient_receives" && Boolean(intent.receiveTokenAmount);
}

/** Parse the server's serialized quote back into the client `Quote` shape. */
function hydrateQuote(q: any): Quote {
  return {
    ...q,
    gasLimit: q.gasLimit ? BigInt(q.gasLimit) : undefined,
    gasPriceWei: q.gasPriceWei ? BigInt(q.gasPriceWei) : undefined,
  };
}

/**
 * Rebuild a partial-balance plan from *fresh* balances, exactly as the single
 * quote path does. Every amount comes from a live quote; the two legs carry
 * real on-chain bounds, so a sandwich can only make the transaction revert.
 */
async function fetchPartialPlan(
  intent: {
    recipient: string;
    receiveToken: string;
    receiveTokenAddress?: string;
    receiveAmount: string;
    receiveTokenAmount?: string;
    network: MonadNetwork;
  },
  balances: Balance[],
  sender: `0x${string}`,
  receiveSymbol: string,
  slippageBps?: number,
): Promise<{ ok: true; fresh: FreshPlan } | { ok: false; reason: any }> {
  const target = intent.receiveTokenAmount;
  if (!target) return { ok: false, reason: "not_ready" };

  // Which funded asset covers the shortfall: the most valuable non-target hold,
  // chosen from the fresh balances (never guessed). Native MON is excluded — it
  // is needed for gas, so it is not spent on a shortfall.
  const targetAddr = (intent.receiveTokenAddress ?? "").toLowerCase();
  const funded = balances
    .filter((b) => !b.token.native)
    .filter((b) => (b.token.address ?? "").toLowerCase() !== targetAddr)
    .filter((b) => Number.isFinite(b.usd) && b.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  const source = funded[0];
  if (!source) return { ok: false, reason: "insufficient_balance" };

  const held =
    balances.find(
      (b) =>
        !b.token.native &&
        ((b.token.address ?? "").toLowerCase() === targetAddr ||
          (b.token.symbol ?? "").toLowerCase() === receiveSymbol.toLowerCase()),
    )?.amount ?? "0";

  const res = await fetch("/api/partial", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetToken: intent.receiveTokenAddress ?? receiveSymbol,
      targetAmount: target,
      held,
      sourceToken: source.token.address,
      sender,
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    return {
      ok: false,
      reason: json.code === "route_unavailable" ? "quote_unavailable" : json.code ?? "quote_unavailable",
    };
  }
  if (json.direct) return { ok: false, reason: "not_ready" };

  const recipient = intent.recipient as `0x${string}`;
  const directQuote = hydrateQuote(json.legs.directQuote);
  const swapQuote = hydrateQuote(json.legs.swapQuote);
  // Both legs must name the real recipient so the guard's quote-match passes
  // and the calldata pays the right address.
  directQuote.intent.recipient = recipient;
  swapQuote.intent.recipient = recipient;

  const plan = buildPartialPlan({
    directQuote,
    swapQuote,
    sender,
    recipient,
    slippageBps: slippageBps ?? 50,
  });
  return {
    ok: true,
    fresh: {
      plan,
      quotes: [directQuote, swapQuote],
      receiveToken: receiveSymbol,
      expectedReceive: target,
    },
  };
}

/**
 * Coverage for a split: the wallet must fund the direct (target) leg AND the
 * swap leg's source asset. A single-asset check is not enough.
 */
function coversPartialPlan(balances: Balance[], plan: PaymentPlanLike): boolean {
  // Only steps that actually move tokens are counted: an approval is an
  // allowance, not a transfer, so counting it too would double the requirement.
  const needed = new Map<string, bigint>();
  const add = (key: string, amount: bigint) => needed.set(key, (needed.get(key) ?? 0n) + amount);
  for (const step of plan.steps) {
    if (step.kind === "transfer") {
      const token = step.token as { address?: string; symbol: string } | null;
      if (step.token === null) continue; // native transfer, covered by the gas reserve
      add((token!.address ?? token!.symbol).toLowerCase(), step.amount as bigint);
    } else if (step.kind === "swap") {
      const tokens: string[] = step.tokens ?? [];
      if (!tokens.length) continue;
      const amount = (step.amountIn ?? step.amountInMaximum) as bigint | undefined;
      if (amount == null) continue;
      add(tokens[0].toLowerCase(), amount);
    }
  }
  for (const [key, required] of needed) {
    const bal = balances.find(
      (b) =>
        (b.token.address ?? "").toLowerCase() === key ||
        (b.token.symbol ?? "").toLowerCase() === key,
    );
    if (!bal) return false;
    try {
      if (parseUnits(bal.amount, bal.token.decimals) < required) return false;
    } catch {
      return false;
    }
  }
  return true;
}

type PaymentPlanLike = { steps: { kind: string; [k: string]: any }[] };

/** Reads live balances for a connected wallet via the balances API. */
function useLiveBalances(address: string | undefined, network: MonadNetwork, tick: number) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setBalances([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/balances?address=${address}&network=${network}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.ok) return;
        // Balance tokens come from external discovery; normalize every one so a
        // missing display field can never blank the UI downstream.
        const list = ((json.balances as { token: Partial<TokenConfig> & { address?: string }; amount: string; usd: number }[]) ?? []).map(
          (b) => ({ ...b, token: normalizeTokenConfig(b.token) }),
        );
        setBalances(list as Balance[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, network, tick]);

  return { balances, loading };
}
