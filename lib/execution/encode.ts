import type { Address } from "viem";
import { encodeFunctionData } from "viem";
import { ERC20_ABI, SWAP_ROUTER_ABI, WNATIVE_ABI } from "./abis";
import { encodePath } from "./path";
import type { PlanStep } from "./plan";
import { UNISWAP, WMON_ADDRESS } from "@/lib/providers/constants";

/**
 * Calldata encoding for a payment plan.
 *
 * This lives outside `execute.ts` on purpose: `execute.ts` is a `"use client"`
 * module (it drives the wallet), so a server route cannot import from it. The
 * developer API builds calldata server-side, and it must be the *same* encoder
 * the browser uses — a second implementation would drift and the API would
 * prepare a different transaction than the app. `execute.ts` re-exports these so
 * there is still one public shape.
 */

/** A single encoded call — the common shape of a sequential tx and a batch entry. */
export type EncodedCall = { to: Address; data?: `0x${string}`; value?: bigint };

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
