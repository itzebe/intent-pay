"use client";

import type { Address, Hash, WalletClient } from "viem";
import { encodeFunctionData } from "viem";
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
  constructor(
    message: string,
    code: "rejected" | "reverted" | "submitted" | "unknown",
    stepId?: string,
  ) {
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

/** A single encoded call — the common shape of a sequential tx and a batch entry. */
export type EncodedCall = { to: Address; data?: `0x${string}`; value?: bigint };

/**
 * Encode one plan step into a `{to, data, value}` call. Shared by the
 * sequential executor and the EIP-5792 batched executor so the two paths can
 * never drift.
 */
export function encodeStep(step: PlanStep): EncodedCall {
  const wmon = WMON_ADDRESS as Address;
  switch (step.kind) {
    case "approve":
      return {
        to: step.token.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [step.spender, step.amount],
        }),
      };
    case "wrap":
      return {
        to: wmon,
        data: encodeFunctionData({ abi: WNATIVE_ABI, functionName: "deposit" }),
        value: step.amount,
      };
    case "unwrap":
      return {
        to: wmon,
        data: encodeFunctionData({ abi: WNATIVE_ABI, functionName: "withdraw", args: [step.amount] }),
      };
    case "swap": {
      const router = UNISWAP.swapRouter02 as Address;
      if (step.tokens.length === 2) {
        if (step.direction === "exact_in") {
          return {
            to: router,
            data: encodeFunctionData({
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
            }),
          };
        }
        return {
          to: router,
          data: encodeFunctionData({
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
          }),
        };
      }
      if (step.direction === "exact_in") {
        return {
          to: router,
          data: encodeFunctionData({
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
          }),
        };
      }
      return {
        to: router,
        data: encodeFunctionData({
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
        }),
      };
    }
    case "transfer":
      if (!step.token) return { to: step.to, value: step.amount };
      return {
        to: step.token.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [step.to, step.amount],
        }),
      };
  }
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
