"use client";

import type { Hash, WalletClient } from "viem";
import { getClientPublicClient } from "@/lib/wallet/clients";
import { sendTransactionViaWallet } from "@/lib/wallet/sendTransaction";
import { prepareTxFields } from "./prepareTx";
import { stepGasUnits } from "./plan";
import type { MonadNetwork } from "@/lib/config/chains";
import type { PaymentPlan, PlanStep } from "./plan";
import { encodeStep, type EncodedCall } from "./encode";

export { encodeStep };
export type { EncodedCall };

export type StepResult = {
  stepId: string;
  label: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  /**
   * The transaction was broadcast but its receipt was not observed within the
   * confirmation window. It may still confirm — the hash must be preserved and
   * its status checked, and the payment must not be treated as delivered.
   */
  unconfirmed?: boolean;
  hash?: Hash;
  error?: string;
};

/**
 * Block confirmations to wait for before a step is treated as confirmed.
 *
 * Monad reaches full finality after two blocks (~600 ms); at one block a block
 * is only *speculatively* final and can (very rarely) revert. Waiting for full
 * finality means the receipt we verify delivery from is the one that cannot be
 * reorged.
 */
export const FINALITY_CONFIRMATIONS = 2;

export type ExecuteCallbacks = { onStep?: (result: StepResult) => void };

export class ExecutionError extends Error {
  /**
   * `rejected`/`reverted` happened before any submission completed;
   * `submitted` means a transaction was sent but its outcome is unresolved or
   * unsuccessful — the caller must NOT retry it blindly;
   * `unknown` is any other definite pre-submission failure.
   */
  code: "rejected" | "reverted" | "submitted" | "unknown";
  stepId?: string;
  /**
   * The underlying value thrown by the wallet/RPC (a viem `BaseError`, an
   * EIP-1193 provider error, …). Preserved so `classifyTransactionError` can
   * read the *real* cause — e.g. a gas shortfall or a simulation revert — instead
   * of only our fixed wrapper sentence. Without it a genuine cause is lost and
   * a small payment can only ever surface as the generic fallback.
   */
  cause?: unknown;
  constructor(
    message: string,
    code: "rejected" | "reverted" | "submitted" | "unknown",
    stepId?: string,
    cause?: unknown,
  ) {
    super(message);
    this.code = code;
    this.stepId = stepId;
    this.cause = cause;
  }
}

function isUserRejection(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  const msg = String(err?.shortMessage ?? err?.message ?? "");
  return code === 4001 || /user rejected|denied transaction/i.test(msg);
}

async function submitStep(
  step: PlanStep,
  walletClient: WalletClient,
  network: MonadNetwork,
): Promise<Hash> {
  const account = walletClient.account!.address;
  // The app owns the calldata (encodeStep) and submits a single raw
  // `eth_sendTransaction` with an explicit chainId, so the wallet is never asked
  // to answer `eth_chainId` / `eth_estimateGas` / `eth_getTransactionCount` —
  // the reads a Trust Wallet provider proxies to its own (possibly blocked) node.
  // See `lib/wallet/sendTransaction.ts`.
  const call = encodeStep(step);
  // Fill the envelope (gas / EIP-1559 fees / nonce) from the app's OWN RPC, so a
  // wallet whose own node is unreachable has nothing left to estimate or fetch
  // before it can sign. The nonce is always read, even for a single-step plan: a
  // wallet asked to supply it does so *after* the user authorises, and a wallet
  // whose own node is unreachable then fails post-PIN (the reported defect).
  // Best-effort: an unreadable field is omitted, never fabricated.
  const prepared = await prepareTxFields(getClientPublicClient(network), call, {
    account,
    fallbackGas: stepGasUnits(step),
  });
  const result = await sendTransactionViaWallet(walletClient, account, call, network, prepared);
  if (result.ok) return result.hash;
  if (result.reason === "rejected") {
    throw new ExecutionError("You rejected the transaction.", "rejected", step.id, result.error);
  }
  throw new ExecutionError("The transaction could not be sent.", "unknown", step.id, result.error);
}

/**
 * Execution layer. Runs a PaymentPlan step by step, waiting for each receipt
 * before moving on. Never reports success without an on-chain receipt.
 */
export async function executePlan(
  plan: PaymentPlan,
  walletClient: WalletClient,
  network: MonadNetwork,
  callbacks: ExecuteCallbacks = {},
): Promise<{ primaryHash?: Hash; results: StepResult[]; confirmed: boolean }> {
  if (!plan.executable) {
    throw new ExecutionError("This payment has no executable on-chain route.", "unknown");
  }
  const client = getClientPublicClient(network);
  const results: StepResult[] = [];
  let primaryHash: Hash | undefined;
  // Every step must reach a successful receipt for the plan to count as
  // confirmed. A step whose receipt was not observed within the window leaves
  // this false so the caller reports an *unknown* outcome, never success.
  let confirmed = true;

  const report = (r: StepResult) => {
    const idx = results.findIndex((x) => x.stepId === r.stepId);
    if (idx >= 0) results[idx] = r;
    else results.push(r);
    callbacks.onStep?.(r);
  };

  for (const step of plan.steps) {
    report({ stepId: step.id, label: step.label, status: "pending" });
    let hash: Hash;
    try {
      // Every step — including a single-step native transfer — is submitted with
      // the envelope the app prepared itself (gas, fees and a fresh nonce). A
      // wallet whose own node is unreachable then has nothing left to read before
      // it can sign. The nonce is re-read per step so a sequence cannot reorder.
      hash = await submitStep(step, walletClient, network);
      report({ stepId: step.id, label: step.label, status: "submitted", hash });
      if (step.id === plan.primaryStepId) primaryHash = hash;
    } catch (err) {
      // `submitStep` already raises a classified ExecutionError carrying the raw
      // provider error on `cause` and the failing step id. Re-throw it unchanged
      // so the real cause is not buried under a second wrapper.
      if (err instanceof ExecutionError) {
        report({ stepId: step.id, label: step.label, status: "failed", error: err.message });
        throw err;
      }
      const rejected = isUserRejection(err);
      report({ stepId: step.id, label: step.label, status: "failed", error: (err as Error)?.message });
      throw new ExecutionError(
        rejected ? "You rejected the transaction." : "The transaction could not be sent.",
        rejected ? "rejected" : "unknown",
        step.id,
        err,
      );
    }

    try {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: FINALITY_CONFIRMATIONS,
        timeout: 90_000,
      });
      if (receipt.status === "reverted") {
        report({ stepId: step.id, label: step.label, status: "failed", hash, error: "Reverted on-chain" });
        throw new ExecutionError("The transaction reverted on Monad.", "reverted", step.id);
      }
      report({ stepId: step.id, label: step.label, status: "confirmed", hash });
    } catch (err) {
      if (err instanceof ExecutionError) throw err;
      // The transaction was broadcast (we hold its hash) but its receipt was not
      // observed within the window. This is an *unknown* outcome, not a failure:
      // it may still confirm. Stop here — do not run the remaining steps, which
      // were built to follow a confirmed predecessor — and let the caller report
      // the ambiguity honestly and offer a safe status check. The hash is kept.
      confirmed = false;
      report({
        stepId: step.id,
        label: step.label,
        status: "submitted",
        unconfirmed: true,
        hash,
        error: "Confirmation not observed within the window",
      });
      break;
    }
  }

  return { primaryHash, results, confirmed };
}
