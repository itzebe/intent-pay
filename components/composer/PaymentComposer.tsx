"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { formatAmount, isEvmAddress } from "@/lib/format";
import { usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet } from "@/lib/hooks/useWallet";
import { useTokenCatalog } from "@/lib/hooks/useTokenCatalog";
import { buildPaymentPlan, describePlan } from "@/lib/execution/plan";
import { executePlan, executePlanBatched, ExecutionError, type StepResult } from "@/lib/execution/execute";
import { getWalletCapabilities, type WalletCapabilities } from "@/lib/execution/alchemy";
import { verifyDelivery } from "@/lib/execution/verify";
import { getClientPublicClient } from "@/lib/wallet/clients";
import type { MonadNetwork } from "@/lib/config/chains";
import { NETWORKS } from "@/lib/config/chains";
import type { Balance } from "@/lib/domain/intent";
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
import { Check, Lock, Spinner, Warning } from "@/components/ui/Icons";

type Stage = "compose" | "review" | "executing" | "success";

/** Every confirmed/submitted hash a plan produced, in execution order. */
function hashOf(results: StepResult[]): `0x${string}`[] {
  return results
    .filter((r): r is StepResult & { hash: `0x${string}` } => Boolean(r.hash))
    .map((r) => r.hash);
}

export function PaymentComposer({ networkLabel }: { networkLabel: string }) {
  const flow = usePaymentFlow();
  const wallet = useWallet(flow.network);
  const catalog = useTokenCatalog(flow.network);
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

  const recipientValid = isEvmAddress(flow.intent.recipient);

  // Ask the wallet what it supports (EIP-5792 atomic batch + paymaster). This
  // is what lets us offer sponsored / ERC-20 gas only when it can actually work.
  useEffect(() => {
    if (!wallet.provider) {
      setWalletCaps(null);
      return;
    }
    let cancelled = false;
    getWalletCapabilities(wallet.provider, NETWORKS[flow.network].chainId).then((caps) => {
      if (!cancelled) setWalletCaps(caps);
    });
    return () => {
      cancelled = true;
    };
  }, [flow.network, wallet.provider, wallet.address]);

  // Effective gas mode for this payment: what the user should expect.
  const gasMode: "sponsored" | "erc20" | "native" =
    flow.capabilities?.gas.sponsorshipConfigured && walletCaps?.paymasterService
      ? "sponsored"
      : "native";

  // Live balances for a connected wallet (live mode only).
  const { balances: liveBalances, loading: liveLoading } = useLiveBalances(
    wallet.address,
    flow.network,
  );
  useEffect(() => {
    if (wallet.address) {
      flow.setBalances(liveBalances);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBalances, wallet.address]);

  // Routability is discovered, not hardcoded: in live mode we ask the routing
  // layer which tokens were actually probed and have a liquid route. Tokens we
  // haven't probed stay `null` (unknown) rather than being shown as unsupported.
  const availability = useMemo(() => {
    const map: Record<string, boolean | null> = {};
    for (const t of catalog.tokens) {
      if (typeof t.routable === "boolean") map[t.symbol] = t.routable;
    }
    return map;
  }, [catalog.tokens]);

  const canContinue =
    recipientValid &&
    Boolean(flow.quote) &&
    !flow.quoting &&
    !flow.quoteError &&
    flow.sufficiency.status !== "insufficient" &&
    // A stale price must be refreshed before it can be reviewed or signed.
    !flow.quoteStale &&
    !flow.mismatch?.active;

  const onReview = useCallback(() => {
    if (!flow.quote) return;
    setError(null);
    setStage("review");
  }, [flow.quote]);

  const plan = useMemo(() => {
    if (!flow.quote) return null;
    try {
      return buildPaymentPlan(
        flow.quote,
        (wallet.address ?? flow.intent.recipient) as `0x${string}`,
        flow.intent.recipient as `0x${string}`,
      );
    } catch {
      return null;
    }
  }, [flow.quote, wallet.address, flow.intent.recipient]);

  // One atomic approval instead of N, when the wallet supports EIP-5792 batches.
  const batchable =
    Boolean(walletCaps?.atomicBatch) && Boolean(plan?.executable) && (plan?.steps.length ?? 0) > 1;

  const onConfirm = useCallback(async () => {
    if (!flow.quote || !plan) return;
    setError(null);
    setSteps([]);
    setDelivery(null);

    if (!wallet.address || !wallet.walletClient) {
      setError("Connect your wallet to pay on Monad.");
      return;
    }

    // Stale-quote guard: never sign a price the user saw minutes ago. If the
    // quote aged out, force a fresh one and ask them to review again.
    if (flow.quoteStale) {
      flow.refreshQuote();
      setError("This price expired. We're refreshing it — review and confirm again.");
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
      // Prefer an atomic EIP-5792 batch when the wallet supports it and the plan
      // has more than one step — one approval instead of N. Falls back to
      // sequential transactions if the wallet rejects the batch.
      const useBatch =
        plan.executable &&
        plan.steps.length > 1 &&
        walletCaps?.atomicBatch &&
        wallet.provider;

      let primaryHash: `0x${string}` | undefined;
      let stepHashes: `0x${string}`[] = [];
      if (useBatch) {
        try {
          const result = await executePlanBatched(
            plan,
            wallet.provider!,
            wallet.address,
            NETWORKS[flow.network].chainId,
            flow.network,
            {
              policyId:
                flow.capabilities?.gas.sponsorshipConfigured
                  ? flow.capabilities.gas.policyId
                  : undefined,
            },
            { onStep },
          );
          primaryHash = result.primaryHash;
          stepHashes = hashOf(result.results);
        } catch (batchErr) {
          // If the wallet advertises the capability but the batch still fails
          // for a non-rejection reason, fall back to sequential execution.
          if (batchErr instanceof ExecutionError && batchErr.code === "rejected") throw batchErr;
          const result = await executePlan(plan, wallet.walletClient, flow.network, { onStep });
          primaryHash = result.primaryHash;
          stepHashes = hashOf(result.results);
        }
      } else {
        const result = await executePlan(plan, wallet.walletClient, flow.network, { onStep });
        primaryHash = result.primaryHash;
        stepHashes = hashOf(result.results);
      }

      setTxHash(primaryHash);

      // Verify the recipient actually received the intended amount — a confirmed
      // tx is not the same thing as a fulfilled intent. When the output token is
      // native and a swap is required, the primary receipt is the swap (which
      // delivers to the sender), so the unwrap/transfer steps must be included
      // for the recipient's balance change to be observed.
      const hashes = stepHashes.length ? stepHashes : primaryHash ? [primaryHash] : [];
      if (hashes.length) {
        try {
          const check = await verifyDelivery(
            getClientPublicClient(flow.network),
            hashes,
            flow.receiveTokenConfig,
            flow.intent.recipient,
            flow.quote.receiveAmount,
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
  }, [
    flow.quote,
    flow.network,
    flow.receiveTokenConfig,
    flow.intent.recipient,
    flow.capabilities,
    flow.quoteStale,
    plan,
    wallet,
    walletCaps,
  ]);

  const reset = useCallback(() => {
    setStage("compose");
    setSteps([]);
    setError(null);
    setTxHash(undefined);
    flow.refreshQuote();
  }, [flow]);

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
            {/* Optional natural-language front door. It only pre-fills the
                fields below; the same quote → review → approval flow runs. */}
            <div className="sm:col-span-2">
              <IntentEngine
                onPrefilled={() =>
                  composeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              />
            </div>

            {/* left: intent */}
            <div ref={composeRef} className="min-w-0 scroll-mt-24 space-y-4">
              <Step n={1}>
                <RecipientField
                  value={flow.intent.recipient}
                  onChange={flow.setRecipient}
                />
              </Step>

              <Step n={2}>
                <ModeToggle value={flow.intent.amountMode} onChange={flow.setAmountMode} />
                <div className="mt-3">
                  <AmountField
                    amount={flow.intent.receiveAmount}
                    onAmountChange={flow.setReceiveAmount}
                    token={flow.receiveTokenConfig}
                    onOpenToken={() => setTokenModal("receive")}
                    label={
                      flow.intent.amountMode === "recipient_receives"
                        ? "Recipient receives"
                        : "I spend"
                    }
                    usdHint={
                      flow.intent.amountMode === "recipient_receives"
                        ? `They get exactly $${flow.intent.receiveAmount || "0"} in ${flow.receiveTokenConfig.symbol}`
                        : `You spend exactly $${flow.intent.receiveAmount || "0"} in ${flow.payTokenConfig.symbol}`
                    }
                  />
                </div>
              </Step>

              <Step n={3}>
                <PayAssetPicker
                  balances={flow.balances}
                  selected={flow.payToken}
                  recommended={flow.recommendedPayToken}
                  availability={availability}
                  catalog={catalog.tokens}
                  network={flow.network}
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
                    {`Not enough ${flow.payToken}. You need ${formatAmount(flow.sufficiency.required)} ${flow.payToken} but hold ${formatAmount(flow.sufficiency.available)}. Short by ${formatAmount(flow.sufficiency.shortfall)} ${flow.payToken}.`}
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
                recipientValid={recipientValid}
              />

              <LiveCalculation
                quote={flow.quote}
                quoting={flow.quoting}
                error={flow.quoteError}
                payToken={flow.payTokenConfig}
                receiveToken={flow.receiveTokenConfig}
                onUseAlternative={(s) => flow.setReceiveToken(s)}
              />

              <BalanceOverview
                balances={flow.balances}
                loading={liveLoading}
              />

              <button
                onClick={onReview}
                disabled={!canContinue}
                className="btn-primary w-full"
              >
                {flow.mismatch?.active ? (
                  <>Fix amount to continue</>
                ) : flow.quoting ? (
                  <>
                    <Spinner className="h-4 w-4 animate-spin" /> Pricing…
                  </>
                ) : !recipientValid ? (
                  <>Enter a recipient address</>
                ) : flow.quoteError ? (
                  <>No route available</>
                ) : flow.sufficiency.status === "insufficient" ? (
                  <>Insufficient balance</>
                ) : flow.quoteStale ? (
                  <>
                    <Spinner className="h-4 w-4 animate-spin" /> Refreshing price…
                  </>
                ) : (
                  <>
                    <Lock className="h-4 w-4" /> Review payment
                  </>
                )}
              </button>
            </div>
          </motion.div>
        )}

        {stage === "review" && flow.quote && plan && (
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
              planSteps={describePlan(plan)}
              onConfirm={onConfirm}
              onBack={() => setStage("compose")}
              confirming={false}
              error={error}
              networkLabel={networkLabel}
              gasMode={gasMode}
              batchable={batchable}
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
            <h3 className="text-lg font-semibold text-white">
              Waiting for confirmation…
            </h3>
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
              network={flow.network}
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
          network={flow.network}
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
          selected={flow.payToken}
          availability={availability}
          network={flow.network}
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

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="relative">
      <div className="mb-2 flex items-center gap-2">
        <span className="num flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.06] text-[10px] font-bold text-white/60">
          {n}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/35">
          {n === 1 ? "Recipient" : n === 2 ? "What should they receive?" : "How will you pay?"}
        </span>
      </div>
      {children}
    </div>
  );
}

/** Reads live balances for a connected wallet via the balances API. */
function useLiveBalances(
  address: string | undefined,
  network: MonadNetwork,
) {
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
  }, [address, network]);

  return { balances, loading };
}
