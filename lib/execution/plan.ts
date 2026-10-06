import type { Address } from "viem";
import type { TokenConfig } from "@/lib/config/tokens";
import { getToken } from "@/lib/config/tokens";
import type { Quote } from "@/lib/domain/intent";
import { parseUnits } from "@/lib/domain/math";
import { WMON_ADDRESS, UNISWAP } from "@/lib/providers/constants";

/** Slippage tolerance applied to route limits (50 bps). */
export const SLIPPAGE_BPS = 50n;
const BPS = 10_000n;

export type SwapDirection = "exact_in" | "exact_out";

export type PlanStep =
  | { id: string; kind: "approve"; label: string; token: TokenConfig; spender: Address; amount: bigint }
  | { id: string; kind: "wrap"; label: string; amount: bigint }
  | { id: string; kind: "unwrap"; label: string; amount: bigint }
  | {
      id: string;
      kind: "swap";
      label: string;
      direction: SwapDirection;
      tokens: Address[];
      fees: number[];
      recipient: Address;
      amountIn?: bigint;
      amountOut?: bigint;
      limit: bigint;
    }
  | { id: string; kind: "transfer"; label: string; token: TokenConfig | null; to: Address; amount: bigint };

export type PaymentPlan = {
  steps: PlanStep[];
  /** The step whose tx hash represents the payment. */
  primaryStepId: string;
  /** True when the plan touches the network at all. */
  executable: boolean;
  note?: string;
};

export function poolTokenAddress(token: TokenConfig): Address {
  return (token.native ? WMON_ADDRESS : token.address) as Address;
}

function applySlipOut(amount: bigint): bigint {
  return (amount * (BPS - SLIPPAGE_BPS)) / BPS;
}
function applySlipIn(amount: bigint): bigint {
  return (amount * (BPS + SLIPPAGE_BPS)) / BPS;
}

/**
 * Transaction construction layer.
 *
 * Turns a Quote into an ordered list of wallet steps. It handles the four
 * real edge cases on Monad:
 *  - native MON must be wrapped to WMON to enter a pool,
 *  - a swap that outputs MON must be unwrapped before delivery,
 *  - ERC-20 inputs need an allowance to the SwapRouter02,
 *  - same-asset payments are a plain transfer.
 *
 * `sender` is used as the swap recipient when the output token is native so the
 * WMON can be unwrapped; otherwise the swap delivers straight to `recipient`.
 */
export function buildPaymentPlan(
  quote: Quote,
  sender: Address,
  recipient: Address,
): PaymentPlan {
  const { payToken, receiveToken, route } = quote;
  const steps: PlanStep[] = [];
  let n = 0;
  const id = (k: string) => `${k}-${n++}`;

  // ---- Same asset: a direct transfer -------------------------------------
  if (route.kind === "direct" || route.hops.length === 0) {
    const amount = parseUnits(quote.payAmount, payToken.decimals);
    if (payToken.native) {
      steps.push({ id: id("transfer"), kind: "transfer", label: `Send MON to recipient`, token: null, to: recipient, amount });
    } else {
      steps.push({ id: id("transfer"), kind: "transfer", label: `Send ${payToken.symbol} to recipient`, token: payToken, to: recipient, amount });
    }
    return { steps, primaryStepId: steps[0].id, executable: true };
  }

  // ---- Swaps --------------------------------------------------------------
  const outputIsNative = receiveToken.native;
  const inputIsNative = payToken.native;

  const symbols = route.path;
  const tokens = symbols.map((s) => {
    const t = getToken(s);
    if (!t) throw new Error(`Unknown token in route: ${s}`);
    return poolTokenAddress(t);
  });
  const fees = route.hops.map((h) => h.fee);

  const swapRecipient: Address = outputIsNative ? sender : recipient;

  const payAmount = parseUnits(quote.payAmount, payToken.decimals);
  const receiveAmount = parseUnits(quote.receiveAmount, receiveToken.decimals);

  // 1) Provide the input asset in ERC-20 form.
  if (inputIsNative) {
    // Wrap enough to cover the route plus slippage headroom.
    const wrapAmount = quote.exactOutput ? applySlipIn(payAmount) : payAmount;
    steps.push({ id: id("wrap"), kind: "wrap", label: "Wrap MON for the route", amount: wrapAmount });
  }

  // 2) Approve the router to pull the input token.
  const approvalAmount = quote.exactOutput ? applySlipIn(payAmount) : payAmount;
  steps.push({
    id: id("approve"),
    kind: "approve",
    label: `Approve ${quote.exactOutput ? "up to " : ""}${quote.payAmount} ${payToken.symbol} for the route`,
    token: inputIsNative ? { ...payToken, address: WMON_ADDRESS as `0x${string}`, native: false, symbol: "WMON" } : payToken,
    spender: UNISWAP.swapRouter02 as Address,
    amount: approvalAmount,
  });

  // 3) Execute the swap.
  if (quote.exactOutput) {
    steps.push({
      id: id("swap"),
      kind: "swap",
      label: `Convert ${payToken.symbol} → ${receiveToken.symbol}`,
      direction: "exact_out",
      tokens,
      fees,
      recipient: swapRecipient,
      amountOut: receiveAmount,
      limit: approvalAmount,
    });
  } else {
    steps.push({
      id: id("swap"),
      kind: "swap",
      label: `Convert ${payToken.symbol} → ${receiveToken.symbol}`,
      direction: "exact_in",
      tokens,
      fees,
      recipient: swapRecipient,
      amountIn: payAmount,
      limit: applySlipOut(receiveAmount),
    });
  }

  // 4) If the output is native, unwrap and deliver MON to the recipient.
  if (outputIsNative) {
    steps.push({ id: id("unwrap"), kind: "unwrap", label: "Unwrap to MON", amount: receiveAmount });
    steps.push({ id: id("transfer"), kind: "transfer", label: "Send MON to recipient", token: null, to: recipient, amount: receiveAmount });
  }

  const primary = steps.find((s) => s.kind === "swap" || s.kind === "transfer")!;
  return { steps, primaryStepId: primary.id, executable: true };
}

/** Summarise a plan as short human steps for the "transaction details" panel. */
export function describePlan(plan: PaymentPlan): string[] {
  return plan.steps.map((s) => s.label);
}
