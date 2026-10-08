"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { formatAmount, isEvmAddress } from "@/lib/format";
import { usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet } from "@/lib/hooks/useWallet";
import { useTokenCatalog } from "@/lib/hooks/useTokenCatalog";
import { describePlan, buildPaymentPlan, buildPartialPlan } from "@/lib/execution/plan";
import { executePlan, executePlanBatched, ExecutionError, type StepResult } from "@/lib/execution/execute";
import { getWalletCapabilities, type WalletCapabilities } from "@/lib/execution/alchemy";
import { prepareSigning, type FreshPlan } from "@/lib/execution/signGuard";
import { parseUnits } from "@/lib/domain/math";
import { verifyDelivery } from "@/lib/execution/verify";
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
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.intent.network, wallet.provider, wallet.address]);

  // Report the connected account to the flow. An account change invalidates
  // balances, gas eligibility and the whole transaction payload.
  useEffect(() => {
    flow.setWalletAccount(wallet.address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

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

  // A change to the canonical intent after Review invalidates the review: the
  // user must not be able to execute a transaction for an older version. The
  // same applies when the quote is dropped entirely (wallet-account change,
  // network change), which leaves nothing executable to review.
  useEffect(() => {
    if (stage !== "review") return;
    if (!flow.quote || reviewVersionRef.current !== flow.intent.version) {
      setStage("compose");
      reviewVersionRef.current = null;
      setError("Your payment changed. Here's the updated quote — review it again.");
      setSteps([]);
      setDelivery(null);
      setTxHash(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.intent.version, flow.quote, stage]);

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

  // The execution-safety surface for the current quote: MEV capability,
  // slippage tolerance, and the price-impact assessment. Derived from real
  // configuration + the live quote, never from a hardcoded badge.
  const protection: ExecutionProtection | null = useMemo(
    () =>
      flow.quote
        ? resolveExecutionProtection(flow.quote.priceImpact)
        : null,
    [flow.quote],
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
    if (!flow.quote) return { steps: [], primaryStepId: "", executable: false, slippageBps: 0 };
    try {
      return buildPaymentPlan(
        flow.quote,
        (wallet.address ?? flow.intent.recipient) as `0x${string}`,
        flow.intent.recipient as `0x${string}`,
      );
    } catch {
      return { steps: [], primaryStepId: "", executable: false, slippageBps: 0 };
    }
  }, [flow.quote, flow.intent.recipient, wallet.address]);

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
    reviewVersionRef.current = flow.intent.version;
    setStage("review");
  }, [flow.readiness.ready, flow.quote, flow.intent.version]);

  const reset = useCallback(() => {
    setStage("compose");
    reviewVersionRef.current = null;
    setSteps([]);
    setError(null);
    setTxHash(undefined);
    setDelivery(null);
    flow.refreshQuote();
  }, [flow]);

  /**
   * Signing safety pipeline. Immediately before the wallet is asked to sign we
   * build a FRESH transaction from the CURRENT intent and fresh live data, and
   * prove the intent did not change while we were preparing. Calldata is never
   * reused from an earlier build.
   */
  const onConfirm = useCallback(async () => {
    setError(null);
    setSteps([]);
    setDelivery(null);

    if (!wallet.address || !wallet.walletClient) {
      setError("Connect your wallet to pay on Monad.");
      return;
    }

    // The approval gate evaluates the CURRENT intent only.
    if (!flow.readiness.ready) {
      flow.refreshQuote();
      setError("This payment changed. Review it again before confirming.");
      return;
    }

    const onChain = await wallet.ensureMonad();
    if (!onChain) {
      setError("Please switch your wallet to Monad to continue.");
      return;
    }

    setStage("executing");
    const onStep = (r: StepResult) =>
      setSteps((prev) => {
        const idx = prev.findIndex((x) => x.stepId === r.stepId);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = r;
          return copy;
        }
        return [...prev, r];
      });

    try {
      // --- Fresh intent build, immediately before signing -------------------
      const prepared = await prepareSigning(
        {
          intent: flow.intent,
          sender: wallet.address,
          recipient: flow.intent.recipient as `0x${string}`,
          // The clamped tolerance encoded into the on-chain swap bound.
          slippageBps: protection?.slippage.bps,
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
          readIntent: () => intentRef.current,
          readAccount: () => accountRef.current,
        },
      );

      if (!prepared.ok) {
        setError(prepared.message);
        setStage("compose");
        reviewVersionRef.current = null;
        flow.refreshQuote();
        return;
      }

      const plan = prepared.plan;

      // Prefer an atomic EIP-5792 batch when the wallet supports it and the plan
      // needs more than one step, or when gas is abstracted (a single-step
      // payment must still go through `wallet_sendCalls` for a paymaster to
      // sponsor it).
      const useBatch =
        plan.executable &&
        Boolean(wallet.provider) &&
        Boolean(walletCaps?.atomicBatch) &&
        (plan.steps.length > 1 || prepared.gasMode !== "native");

      let primaryHash: `0x${string}` | undefined;
      let stepHashes: `0x${string}`[] = [];
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

      setStage("success");
    } catch (err) {
      const message =
        err instanceof ExecutionError ? err.message : "The payment could not be completed.";
      setError(message);
      setStage("review");
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
                            ? `You spend exactly $${flow.intent.receiveAmount || "0"} in ${amountToken.symbol}`
                            : `They get exactly $${flow.intent.receiveAmount || "0"} in ${amountToken.symbol}`
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
                  selected={flow.intent.payToken}
                  payTokenIsSet={
                    flow.intent.payTokenSource === "user" || flow.intent.payTokenSource === "intent"
                  }
                  recommended={flow.recommendedPayToken}
                  availability={availability}
                  catalog={catalog.tokens}
                  network={flow.intent.network}
                  onAddToken={flow.addToken}
                  optimizer={flow.optimizer}
                  optimizerLoading={flow.optimizerLoading}
                  onSelect={(s) => flow.setPayToken(s, true)}
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
                flow.gasSufficiency.status === "insufficient" && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-start gap-2 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-3.5 text-xs text-amber-100"
                  >
                    <Warning className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {`You need a small amount of MON for network fees (about ${formatAmount(
                        flow.gasSufficiency.requiredMon,
                      )} MON). Your wallet holds ${formatAmount(
                        flow.gasSufficiency.availableMon,
                      )} MON. Wallet abstraction is unavailable: ${
                        !flow.gasInfo.paymasterConfigured
                          ? "no paymaster is configured for this deployment"
                          : "your wallet does not advertise sponsored (EIP-5792) gas"
                      }, so this payment must be paid in MON.`}
                    </span>
                  </motion.div>
                )}
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

        {stage === "review" && flow.quote && (
          <motion.div
            key="review"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-h-[80vh] overflow-hidden"
          >
            <ReviewSheet
              quote={flow.quote}
              payToken={flow.payTokenConfig}
              receiveToken={flow.receiveTokenConfig}
              recipient={flow.intent.recipient}
              planSteps={describePlan(displayPlan)}
              onConfirm={onConfirm}
              onBack={() => {
                setStage("compose");
                reviewVersionRef.current = null;
              }}
              confirming={false}
              error={error}
              networkLabel={networkLabel}
              gasMode={flow.gasMode}
              batchable={Boolean(walletCaps?.atomicBatch)}
              quotedAt={flow.quote.quotedAt}
              quoteStale={flow.quoteStale}
              protection={protection}
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

        {stage === "success" && flow.quote && (
          <motion.div key="success" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-h-[85vh] overflow-y-auto">
            <SuccessScreen
              payToken={flow.payTokenConfig}
              receiveToken={flow.receiveTokenConfig}
              payAmount={flow.quote.payAmount}
              payUsd={flow.quote.payUsd}
              receiveAmount={flow.quote.receiveAmount}
              receiveUsd={flow.quote.receiveUsd}
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
          onSelect={(s) => {
            flow.setReceiveToken(s);
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
          onSelect={(s) => {
            flow.setPayToken(s, true);
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
        if (!cancelled && json.ok) setBalances(json.balances as Balance[]);
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
