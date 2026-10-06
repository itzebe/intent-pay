"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TOKENS, type TokenConfig } from "@/lib/config/tokens";
import { isEvmAddress } from "@/lib/format";
import { usePaymentFlow } from "@/lib/hooks/usePayment";
import { useWallet } from "@/lib/hooks/useWallet";
import { buildPaymentPlan, describePlan } from "@/lib/execution/plan";
import { executePlan, ExecutionError, type StepResult } from "@/lib/execution/execute";
import type { MonadNetwork } from "@/lib/config/chains";
import type { Balance } from "@/lib/domain/intent";
import { Modal } from "@/components/ui/Modal";
import { TokenList } from "@/components/ui/TokenList";
import { RecipientField } from "./RecipientField";
import { AmountField } from "./AmountField";
import { PayAssetPicker } from "./PayAssetPicker";
import { ModeToggle } from "./ModeToggle";
import { MismatchAlert } from "./MismatchAlert";
import { DemoControls } from "./DemoControls";
import { LiveCalculation } from "./LiveCalculation";
import { FlowDiagram } from "@/components/flow/FlowDiagram";
import { ReviewSheet } from "./ReviewSheet";
import { SuccessScreen } from "@/components/success/SuccessScreen";
import { BalanceOverview } from "@/components/wallet/WalletBar";
import { Bolt, Check, Lock, Spinner, Warning } from "@/components/ui/Icons";

type Stage = "compose" | "review" | "executing" | "success";

export function PaymentComposer({ networkLabel }: { networkLabel: string }) {
  const flow = usePaymentFlow();
  const wallet = useWallet(flow.network);
  const [stage, setStage] = useState<Stage>("compose");
  const [tokenModal, setTokenModal] = useState<null | "receive" | "pay">(null);
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | undefined>();

  const recipientValid = isEvmAddress(flow.intent.recipient);

  // Live balances for a connected wallet (live mode only).
  const { balances: liveBalances, loading: liveLoading } = useLiveBalances(
    wallet.address,
    flow.network,
    flow.mode,
  );
  useEffect(() => {
    if (flow.mode === "live" && wallet.address) {
      flow.setBalances(liveBalances);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBalances, wallet.address, flow.mode]);

  const availability = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const t of TOKENS) map[t.symbol] = true;
    return map;
  }, []);

  const canContinue =
    recipientValid &&
    Boolean(flow.quote) &&
    !flow.quoting &&
    !flow.quoteError &&
    flow.sufficiency.status !== "insufficient" &&
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

  const onConfirm = useCallback(async () => {
    if (!flow.quote || !plan) return;
    setError(null);
    setSteps([]);

    // Demo mode: run the delivery experience without touching the chain.
    if (flow.mode === "demo") {
      setStage("executing");
      await runDemoExecution(plan, setSteps);
      setTxHash(undefined);
      setStage("success");
      return;
    }

    if (!wallet.address || !wallet.walletClient) {
      setError("Connect your wallet to pay on Monad.");
      return;
    }
    const onChain = await wallet.ensureMonad();
    if (!onChain) {
      setError("Please switch your wallet to Monad to continue.");
      return;
    }

    setStage("executing");
    try {
      const result = await executePlan(plan, wallet.walletClient, flow.network, {
        onStep: (r) =>
          setSteps((prev) => {
            const idx = prev.findIndex((x) => x.stepId === r.stepId);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = r;
              return copy;
            }
            return [...prev, r];
          }),
      });
      setTxHash(result.primaryHash);
      setStage("success");
    } catch (err) {
      const message =
        err instanceof ExecutionError ? err.message : "The payment could not be completed.";
      setError(message);
      setStage("review");
    }
  }, [flow.quote, flow.mode, flow.network, plan, wallet]);

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
          {flow.mode === "demo" ? (
            <span className="chip text-amber-200/80">
              <Bolt className="h-3 w-3" /> Demo mode
            </span>
          ) : (
            <span className="chip text-emerald-200/80">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live · {networkLabel}
            </span>
          )}
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
            {/* left: intent */}
            <div className="space-y-4">
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
                  onSelect={(s) => flow.setPayToken(s, true)}
                />
              </Step>

              {flow.mode === "demo" && (
                <DemoControls
                  simulateMove={flow.simulateMove}
                  onChange={flow.setSimulateMove}
                />
              )}

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
                    Not enough {flow.payToken}. You need {flow.sufficiency.required}{" "}
                    {flow.payToken} but hold {flow.sufficiency.available}. Short by{" "}
                    {flow.sufficiency.shortfall} {flow.payToken}.
                  </span>
                </motion.div>
              )}
            </div>

            {/* right: live result */}
            <div className="space-y-4">
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
                loading={flow.mode === "live" ? liveLoading : flow.balancesLoading}
                demo={flow.mode === "demo"}
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
              {flow.mode === "demo" ? "Delivering payment…" : "Waiting for confirmation…"}
            </h3>
            <p className="mt-1 max-w-xs text-sm text-white/45">
              {flow.mode === "demo"
                ? "Simulating the delivery steps for the demo."
                : "Approve each step in your wallet. Confirmation usually takes under a second on Monad."}
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
              demo={flow.mode === "demo"}
              onReset={reset}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* token modals */}
      <Modal open={tokenModal === "receive"} onClose={() => setTokenModal(null)} title="Recipient receives">
        <TokenList
          tokens={TOKENS as TokenConfig[]}
          balances={flow.balances}
          selected={flow.intent.receiveToken}
          availability={availability}
          onSelect={(s) => {
            flow.setReceiveToken(s);
            setTokenModal(null);
          }}
        />
      </Modal>
      <Modal open={tokenModal === "pay"} onClose={() => setTokenModal(null)} title="Pay with">
        <TokenList
          tokens={TOKENS as TokenConfig[]}
          balances={flow.balances}
          selected={flow.payToken}
          availability={availability}
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

/** Demo execution: walks the plan with realistic timing, never claims a hash. */
async function runDemoExecution(
  plan: ReturnType<typeof buildPaymentPlan>,
  setSteps: (updater: (prev: StepResult[]) => StepResult[]) => void,
) {
  for (const step of plan.steps) {
    setSteps((prev) => [
      ...prev.filter((s) => s.stepId !== step.id),
      { stepId: step.id, label: step.label, status: "submitted" },
    ]);
    await new Promise((r) => setTimeout(r, 420));
    setSteps((prev) =>
      prev.map((s) => (s.stepId === step.id ? { ...s, status: "confirmed" } : s)),
    );
    await new Promise((r) => setTimeout(r, 160));
  }
}

/** Reads live balances for a connected wallet via the balances API. */
function useLiveBalances(
  address: string | undefined,
  network: MonadNetwork,
  mode: string,
) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== "live" || !address) {
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
  }, [address, network, mode]);

  return { balances, loading };
}
