/**
 * Bounded ERC-20 paymaster allowance for the UserOperation.
 *
 * Pimlico's ERC-20 paymaster recovers the network fee with `transferFrom` in
 * postOp, so the UserOperation must `approve(paymaster, ≥ maxCostInToken)`
 * *before* the payment calls. The approval is:
 *
 *   - the MINIMUM the live quote requires (never unlimited),
 *   - bounded by `boundGasSpend` (≤ half the balance, ≤ a configured ceiling),
 *   - derived from the live paymaster quote (`exchangeRate` + `postOpGas`) and
 *     the UserOperation's own gas fields — never a hardcoded amount.
 *
 * The gas token is a *separate* concern from the payment source: this only ever
 * approves the gas token to the paymaster, and never touches the source asset.
 */

import type { Address } from "viem";
import { encodeFunctionData } from "viem";
import { maxCostInToken } from "./gasCost";
import { boundGasSpend, isSafeSpend } from "./safety";
import type { EncodedCall } from "@/lib/execution/execute";

/** The live paymaster quote, as surfaced by the `/api/aa/paymaster` proxy. */
export type GasPaymasterQuote = {
  paymaster: `0x${string}`;
  /** Present on the POST path; unused by the allowance math. */
  paymasterData?: `0x${string}`;
  paymasterPostOpGasLimit?: bigint;
  paymasterVerificationGasLimit?: bigint;
  token: { address: string; symbol: string; decimals: number };
  exchangeRate: bigint;
  postOpGas: bigint;
  validUntil?: number;
};

/** The minimal ERC-20 `approve` fragment (kept local so nothing drifts). */
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type GasApprovalPlan =
  | { ok: true; amount: bigint; call: EncodedCall; reason: string }
  | { ok: false; reason: string };

/** Read a gas field that may arrive as a bigint or a 0x-hex string. */
function gas(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && value) return BigInt(value);
  return 0n;
}

/**
 * Compute the bounded approval and the `approve` call to prepend to the
 * UserOperation's calls. Fails closed: an unknown quote, an unsafe bound, or a
 * non-positive amount yields `ok: false` (the caller then falls back to MON gas
 * rather than sending an unbounded approval).
 */
export function planGasApproval(input: {
  userOperation: Record<string, unknown>;
  quote: GasPaymasterQuote;
  /** The user's on-chain balance of the gas token, base units. */
  gasTokenBalance: bigint;
  /** Operator-configured absolute ceiling, base units (optional). */
  configuredMax?: bigint;
}): GasApprovalPlan {
  const { userOperation, quote, gasTokenBalance, configuredMax } = input;

  const userOperationMaxGas =
    gas(userOperation.callGasLimit) +
    gas(userOperation.verificationGasLimit) +
    gas(userOperation.preVerificationGas) +
    gas(userOperation.paymasterVerificationGasLimit) +
    gas(userOperation.paymasterPostOpGasLimit);
  const maxFeePerGas = gas(userOperation.maxFeePerGas);

  if (quote.exchangeRate <= 0n) {
    return { ok: false, reason: "The paymaster quote has no exchange rate." };
  }
  if (maxFeePerGas <= 0n) {
    return { ok: false, reason: "The UserOperation has no maxFeePerGas." };
  }

  // The exact amount the paymaster will pull, per its published formula.
  const required = maxCostInToken({
    userOperationMaxGas,
    postOpGas: quote.postOpGas,
    maxFeePerGas,
    exchangeRate: quote.exchangeRate,
  });
  if (required <= 0n) {
    return { ok: false, reason: "The paymaster quote yields a zero token cost." };
  }

  // Bound the approval: never unlimited, never more than half the balance, and
  // never below what the quote requires.
  const bound = boundGasSpend({ estimatedCost: required, balance: gasTokenBalance, configuredMax });
  if (!bound.ok) return { ok: false, reason: bound.reason };

  if (!isSafeSpend(bound.maxSpend, gasTokenBalance, required)) {
    return { ok: false, reason: "The bounded gas allowance failed the safety check." };
  }

  return {
    ok: true,
    amount: bound.maxSpend,
    call: {
      to: quote.token.address as Address,
      data: encodeFunctionData({
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [quote.paymaster, bound.maxSpend],
      }),
    },
    reason: `Bounded allowance of ${bound.maxSpend} base units for the gas token (not unlimited).`,
  };
}
