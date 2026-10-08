import type { Address } from "viem";
import type { TokenConfig } from "@/lib/config/tokens";
import { getToken } from "@/lib/config/tokens";
import type { Quote } from "@/lib/domain/intent";
import { formatUnits, parseUnits } from "@/lib/domain/math";
import {
  applySlippageIn,
  applySlippageOut,
  DEFAULT_SLIPPAGE_BPS,
  resolveSlippageBps,
} from "@/lib/domain/protection";
import { WMON_ADDRESS, UNISWAP } from "@/lib/providers/constants";

/**
 * Slippage tolerance applied to route limits (default 50 bps).
 *
 * Kept for back-compat with callers that import it; the value actually
 * enforced by a plan is resolved per-payment (see `buildPaymentPlan`) and
 * clamped by `lib/domain/protection`.
 */
export const SLIPPAGE_BPS = 50n;

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
      /** The on-chain bound: `amountOutMinimum` for exact-in, `amountInMaximum`
       * for exact-out. Encoded into the swap calldata. */
      limit: bigint;
      /**
       * The exact on-chain minimum output for an exact-input swap (base units).
       * Present only for exact-in swaps; the signing guard asserts the encoded
       * calldata carries a non-zero bound no weaker than this.
       */
      amountOutMinimum?: bigint;
      /** The exact on-chain maximum input for an exact-output swap. */
      amountInMaximum?: bigint;
      /** Slippage tolerance (bps) this bound was derived from. */
      slippageBps: number;
    }
  | { id: string; kind: "transfer"; label: string; token: TokenConfig | null; to: Address; amount: bigint };

export type PaymentPlan = {
  steps: PlanStep[];
  /** The step whose tx hash represents the payment. */
  primaryStepId: string;
  /** True when the plan touches the network at all. */
  executable: boolean;
  /** The slippage tolerance (bps) every swap bound in this plan was built with. */
  slippageBps: number;
  note?: string;
};

export function poolTokenAddress(token: TokenConfig): Address {
  return (token.native ? WMON_ADDRESS : token.address) as Address;
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
  slippageBpsInput: number = DEFAULT_SLIPPAGE_BPS,
): PaymentPlan {
  const { payToken, receiveToken, route } = quote;
  const slippageBps = resolveSlippageBps(slippageBpsInput);
  const steps: PlanStep[] = [];
  let n = 0;
  const id = (k: string) => `${k}-${n++}`;

  // ---- Same asset: a direct transfer -------------------------------------
  if (route.kind === "direct") {
    const amount = parseUnits(quote.payAmount, payToken.decimals);
    if (payToken.native) {
      steps.push({ id: id("transfer"), kind: "transfer", label: `Send MON to recipient`, token: null, to: recipient, amount });
    } else {
      steps.push({ id: id("transfer"), kind: "transfer", label: `Send ${payToken.symbol} to recipient`, token: payToken, to: recipient, amount });
    }
    return { steps, primaryStepId: steps[0].id, executable: true, slippageBps };
  }

  // A swap route with no hops carries no pool data to construct a real
  // transaction from, so describe the transformation rather than pretending it
  // is a direct transfer. The execution layer never sends this plan on-chain.
  if (route.hops.length === 0) {
    steps.push({
      id: id("swap"),
      kind: "swap",
      label: `Convert ${payToken.symbol} → ${receiveToken.symbol}`,
      direction: quote.exactOutput ? "exact_out" : "exact_in",
      tokens: [],
      fees: [],
      recipient,
      limit: 0n,
      slippageBps,
    });
    return { steps, primaryStepId: steps[0].id, executable: false, slippageBps };
  }

  // ---- Swaps --------------------------------------------------------------
  const outputIsNative = receiveToken.native;
  const inputIsNative = payToken.native;

  const symbols = route.path;
  // Prefer the route's own token configs — a discovered intermediate token may
  // not be resolvable by symbol, and must still produce a valid plan.
  const pathTokens: TokenConfig[] =
    route.tokens && route.tokens.length === symbols.length
      ? route.tokens
      : symbols.map((s) => {
          const t = getToken(s);
          if (!t) throw new Error(`Unknown token in route: ${s}`);
          return t;
        });
  const tokens = pathTokens.map((t) => poolTokenAddress(t));
  const fees = route.hops.map((h) => h.fee);

  const swapRecipient: Address = outputIsNative ? sender : recipient;

  const payAmount = parseUnits(quote.payAmount, payToken.decimals);
  const receiveAmount = parseUnits(quote.receiveAmount, receiveToken.decimals);

  // 1) Provide the input asset in ERC-20 form.
  if (inputIsNative) {
    // Wrap enough to cover the route plus slippage headroom.
    const wrapAmount = quote.exactOutput ? applySlippageIn(payAmount, slippageBps) : payAmount;
    steps.push({ id: id("wrap"), kind: "wrap", label: "Wrap MON for the route", amount: wrapAmount });
  }

  // 2) Approve the router to pull the input token.
  const approvalAmount = quote.exactOutput ? applySlippageIn(payAmount, slippageBps) : payAmount;
  steps.push({
    id: id("approve"),
    kind: "approve",
    label: `Approve ${quote.exactOutput ? "up to " : ""}${quote.payAmount} ${payToken.symbol} for the route`,
    token: inputIsNative ? { ...payToken, address: WMON_ADDRESS as `0x${string}`, native: false, symbol: "WMON" } : payToken,
    spender: UNISWAP.swapRouter02 as Address,
    amount: approvalAmount,
  });

  // 3) Execute the swap. The on-chain bound is the protection: an exact-output
  //    swap reverts if it would spend more than `amountInMaximum`; an
  //    exact-input swap reverts if it would deliver less than
  //    `amountOutMinimum`. Either way a sandwich that moves the price past the
  //    tolerance makes the transaction revert instead of filling worse.
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
      amountInMaximum: approvalAmount,
      slippageBps,
    });
  } else {
    const minOut = applySlippageOut(receiveAmount, slippageBps);
    steps.push({
      id: id("swap"),
      kind: "swap",
      label: `Convert ${payToken.symbol} → ${receiveToken.symbol}`,
      direction: "exact_in",
      tokens,
      fees,
      recipient: swapRecipient,
      amountIn: payAmount,
      limit: minOut,
      amountOutMinimum: minOut,
      slippageBps,
    });
  }

  // 4) If the output is native, unwrap and deliver MON to the recipient.
  if (outputIsNative) {
    steps.push({ id: id("unwrap"), kind: "unwrap", label: "Unwrap to MON", amount: receiveAmount });
    steps.push({ id: id("transfer"), kind: "transfer", label: "Send MON to recipient", token: null, to: recipient, amount: receiveAmount });
  }

  const primary = steps.find((s) => s.kind === "swap" || s.kind === "transfer")!;
  return { steps, primaryStepId: primary.id, executable: true, slippageBps };
}

/** Summarise a plan as short human steps for the "transaction details" panel. */
export function describePlan(plan: PaymentPlan): string[] {
  return plan.steps.map((s) => s.label);
}

export type PlanEconomics = {
  /** The least the recipient is guaranteed to receive, from the real limits. */
  minimumReceived: string;
  /** Slippage tolerance applied to the route limits, in basis points. */
  slippageBps: number;
  /**
   * True when the output amount is fixed by the plan (a direct transfer or an
   * exact-output swap), so the minimum equals the quoted amount exactly.
   */
  exact: boolean;
};

/**
 * Derive the guaranteed minimum the recipient receives from the plan's own
 * on-chain limits — never a separately invented number. For an exact-output
 * swap (or a direct transfer) the output is fixed; for an exact-input swap the
 * swap step's `amountOutMinimum` is the guarantee.
 */
export function planEconomics(
  quote: Quote,
  slippageBpsInput: number = DEFAULT_SLIPPAGE_BPS,
): PlanEconomics {
  const slippageBps = resolveSlippageBps(slippageBpsInput);
  if (quote.route.kind === "direct" || quote.exactOutput) {
    return { minimumReceived: quote.receiveAmount, slippageBps, exact: true };
  }
  try {
    const out = applySlippageOut(parseUnits(quote.receiveAmount, quote.receiveToken.decimals), slippageBps);
    return {
      minimumReceived: formatUnits(out, quote.receiveToken.decimals),
      slippageBps,
      exact: false,
    };
  } catch {
    return { minimumReceived: quote.receiveAmount, slippageBps, exact: true };
  }
}
