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

/**
 * Per-step gas-unit estimates for a plan on Monad.
 *
 * A payment is only *one* transaction for a direct transfer. A swap payment is
 * several sequential transactions (approve → swap → unwrap → deliver), and each
 * one charges its own network fee in MON. The wallet must be able to pay the fee
 * of **every** step, not just the first — validating only one step's fee is what
 * made a small swap payment fail at the second transaction with the node's
 * "insufficient funds for gas" even though the review had shown a green fee.
 *
 * These are deliberately generous upper bounds; they only ever gate a payment
 * that genuinely cannot pay its fees, never fabricate a cost for one that can.
 */
export const STEP_GAS_UNITS = {
  /** ERC-20 `approve`. */
  approve: 55_000n,
  /** Native MON → WMON deposit. */
  wrap: 60_000n,
  /** WMON → native MON withdraw. */
  unwrap: 60_000n,
  /** Native MON value transfer. */
  transferNative: 30_000n,
  /** ERC-20 `transfer`. */
  transferToken: 65_000n,
  /** Swap base cost, plus a per-hop increment. */
  swapBase: 130_000n,
  swapPerHop: 90_000n,
} as const;

/** The gas units a single plan step is expected to consume. */
export function stepGasUnits(step: PlanStep): bigint {
  switch (step.kind) {
    case "approve":
      return STEP_GAS_UNITS.approve;
    case "wrap":
      return STEP_GAS_UNITS.wrap;
    case "unwrap":
      return STEP_GAS_UNITS.unwrap;
    case "swap":
      return (
        STEP_GAS_UNITS.swapBase +
        BigInt(Math.max(1, step.tokens.length - 1)) * STEP_GAS_UNITS.swapPerHop
      );
    case "transfer":
      return step.token ? STEP_GAS_UNITS.transferToken : STEP_GAS_UNITS.transferNative;
  }
}

/**
 * The total gas units the whole plan will consume — the sum over every step
 * that is a real transaction. `fallback` is used only for a plan with no steps
 * (a direct quote that never produced one), so a caller always has a figure.
 */
export function planGasUnits(plan: PaymentPlan, fallback = 350_000n): bigint {
  let total = 0n;
  for (const step of plan.steps) total += stepGasUnits(step);
  return total > 0n ? total : fallback;
}

// ---------------------------------------------------------------------------
// Partial-balance plan ("send 100 NEWCOIN" while holding only 40)
//
// The recipient must end up with the full amount. The wallet already holds part
// of the target asset, so that part is sent directly; the remainder is obtained
// via a swap from a funded source asset. Both legs target the same recipient and
// the same output token, and each leg keeps its own on-chain bound.
//
// Whether the two legs can go out atomically is a wallet-capability question:
// the EIP-5792 batch path submits the whole step list in one atomic call, and
// the sequential path runs them in order. This builder produces the step list
// for either; it never claims atomicity the wallet can't deliver.
// ---------------------------------------------------------------------------

export type PartialPlanLegs = {
  /** A quote whose pay == receive (the direct transfer of the held amount). */
  directQuote: Quote;
  /** A quote that obtains the shortfall (source -> target). */
  swapQuote: Quote;
  sender: Address;
  recipient: Address;
  slippageBps?: number;
};

export function buildPartialPlan(legs: PartialPlanLegs): PaymentPlan {
  const slippageBps = resolveSlippageBps(legs.slippageBps ?? DEFAULT_SLIPPAGE_BPS);

  // The direct leg is a same-asset transfer; build it as its own plan so the
  // existing (well-tested) construction is reused rather than duplicated.
  const direct = buildPaymentPlan(
    legs.directQuote,
    legs.sender,
    legs.recipient,
    slippageBps,
  );
  const swap = buildPaymentPlan(legs.swapQuote, legs.sender, legs.recipient, slippageBps);

  // Re-id every step with a leg prefix so the two plans' ids can never collide.
  const directSteps = direct.steps.map((s, i) => ({ ...s, id: `direct-${i}-${s.id}` }));
  const swapSteps = swap.steps.map((s, i) => ({ ...s, id: `swap-${i}-${s.id}` }));
  const steps: PlanStep[] = [...directSteps, ...swapSteps];

  // The swap is the step that proves the shortfall was obtained; fall back to
  // the direct transfer when the swap produced no executable step.
  const primary =
    steps.find((s) => s.id.startsWith("swap-") && s.kind === "swap") ??
    steps.find((s) => s.id.startsWith("direct-") && s.kind === "transfer") ??
    steps[0];

  return {
    steps,
    primaryStepId: primary.id,
    // Executable only when both legs are; a non-executable leg (no pool data)
    // means we must not pretend the split can run.
    executable: direct.executable && swap.executable && steps.length > 0,
    slippageBps,
    note: "Partial balance: sends what you hold and swaps the remainder.",
  };
}

/**
 * The least the recipient is guaranteed across a split plan: the direct leg is
 * fixed, and the swap leg's own on-chain bound is its guarantee. Returned as a
 * decimal string in the target token's units.
 */
export function partialPlanMinimum(legs: PartialPlanLegs): string {
  const target = legs.swapQuote.receiveToken;
  const held = parseUnits(legs.directQuote.receiveAmount, target.decimals);
  const shortfallMin = applySlippageOut(
    parseUnits(legs.swapQuote.receiveAmount, target.decimals),
    resolveSlippageBps(legs.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
  );
  return formatUnits(held + shortfallMin, target.decimals);
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
