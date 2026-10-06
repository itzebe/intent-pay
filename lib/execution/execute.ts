"use client";

import type { Address, Hash, WalletClient } from "viem";
import { getClientPublicClient } from "@/lib/wallet/clients";
import type { MonadNetwork } from "@/lib/config/chains";
import { ERC20_ABI, SWAP_ROUTER_ABI, WNATIVE_ABI } from "./abis";
import { encodePath } from "./path";
import type { PaymentPlan, PlanStep } from "./plan";
import { UNISWAP, WMON_ADDRESS } from "@/lib/providers/constants";

export type StepResult = {
  stepId: string;
  label: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  hash?: Hash;
  error?: string;
};

export type ExecuteCallbacks = { onStep?: (result: StepResult) => void };

export class ExecutionError extends Error {
  code: "rejected" | "reverted" | "unknown";
  stepId?: string;
  constructor(message: string, code: "rejected" | "reverted" | "unknown", stepId?: string) {
    super(message);
    this.code = code;
    this.stepId = stepId;
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
  const client = getClientPublicClient(network);
  const account = walletClient.account!;
  const wmon = WMON_ADDRESS as Address;

  switch (step.kind) {
    case "approve":
      return walletClient.writeContract({
        account,
        chain: client.chain,
        address: step.token.address,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [step.spender, step.amount],
      });
    case "wrap":
      return walletClient.writeContract({
        account,
        chain: client.chain,
        address: wmon,
        abi: WNATIVE_ABI,
        functionName: "deposit",
        value: step.amount,
      });
    case "unwrap":
      return walletClient.writeContract({
        account,
        chain: client.chain,
        address: wmon,
        abi: WNATIVE_ABI,
        functionName: "withdraw",
        args: [step.amount],
      });
    case "swap": {
      const router = UNISWAP.swapRouter02 as Address;
      if (step.tokens.length === 2) {
        if (step.direction === "exact_in") {
          return walletClient.writeContract({
            account,
            chain: client.chain,
            address: router,
            abi: SWAP_ROUTER_ABI,
            functionName: "exactInputSingle",
            args: [
              {
                tokenIn: step.tokens[0],
                tokenOut: step.tokens[1],
                fee: step.fees[0],
                recipient: step.recipient,
                amountIn: step.amountIn!,
                amountOutMinimum: step.limit,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
        }
        return walletClient.writeContract({
          account,
          chain: client.chain,
          address: router,
          abi: SWAP_ROUTER_ABI,
          functionName: "exactOutputSingle",
          args: [
            {
              tokenIn: step.tokens[0],
              tokenOut: step.tokens[1],
              fee: step.fees[0],
              recipient: step.recipient,
              amountOut: step.amountOut!,
              amountInMaximum: step.limit,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
      }
      if (step.direction === "exact_in") {
        return walletClient.writeContract({
          account,
          chain: client.chain,
          address: router,
          abi: SWAP_ROUTER_ABI,
          functionName: "exactInput",
          args: [
            {
              path: encodePath(step.tokens, step.fees),
              recipient: step.recipient,
              amountIn: step.amountIn!,
              amountOutMinimum: step.limit,
            },
          ],
        });
      }
      return walletClient.writeContract({
        account,
        chain: client.chain,
        address: router,
        abi: SWAP_ROUTER_ABI,
        functionName: "exactOutput",
        args: [
          {
            path: encodePath(step.tokens, step.fees, true),
            recipient: step.recipient,
            amountOut: step.amountOut!,
            amountInMaximum: step.limit,
          },
        ],
      });
    }
    case "transfer":
      if (!step.token) {
        return walletClient.sendTransaction({
          account,
          chain: client.chain,
          to: step.to,
          value: step.amount,
        });
      }
      return walletClient.writeContract({
        account,
        chain: client.chain,
        address: step.token.address,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [step.to, step.amount],
      });
  }
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
): Promise<{ primaryHash?: Hash; results: StepResult[] }> {
  const client = getClientPublicClient(network);
  const results: StepResult[] = [];
  let primaryHash: Hash | undefined;

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
      hash = await submitStep(step, walletClient, network);
      report({ stepId: step.id, label: step.label, status: "submitted", hash });
      if (step.id === plan.primaryStepId) primaryHash = hash;
    } catch (err) {
      const rejected = isUserRejection(err);
      report({ stepId: step.id, label: step.label, status: "failed", error: (err as Error)?.message });
      throw new ExecutionError(
        rejected ? "You rejected the transaction." : "The transaction could not be sent.",
        rejected ? "rejected" : "unknown",
        step.id,
      );
    }

    try {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 90_000,
      });
      if (receipt.status === "reverted") {
        report({ stepId: step.id, label: step.label, status: "failed", hash, error: "Reverted on-chain" });
        throw new ExecutionError("The transaction reverted on Monad.", "reverted", step.id);
      }
      report({ stepId: step.id, label: step.label, status: "confirmed", hash });
    } catch (err) {
      if (err instanceof ExecutionError) throw err;
      report({
        stepId: step.id,
        label: step.label,
        status: "submitted",
        hash,
        error: "Confirmation timed out",
      });
    }
  }

  return { primaryHash, results };
}
