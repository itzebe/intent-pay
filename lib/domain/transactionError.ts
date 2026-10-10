/**
 * Transaction failure → actionable, user-safe message.
 *
 * A raw provider message ("insufficient funds for gas * price + value", an RPC
 * -32000 string, a viem `ExecutionError`) must never reach the user verbatim:
 * it is unhelpful and can leak internal detail. This module is pure and total
 * so the same mapping is unit-tested and reused by the composer.
 *
 * It deliberately does NOT invent an outcome. An ambiguous post-submission
 * failure is classified `unknown_outcome` and phrased as "may still be
 * processing", never as a definite failure — and never as success.
 */

export type TxErrorKind =
  | "rejected" // the user declined in their wallet
  | "insufficient_gas" // not enough native MON to cover the network fee
  | "insufficient_funds" // not enough of the token being spent
  | "expired_quote" // the quote aged out; must be rebuilt
  | "no_route" // no executable route / unsupported token
  | "slippage" // the swap could not meet the minimum output within tolerance
  | "reverted" // the transaction reverted on-chain
  | "rpc_unavailable" // the node could not be reached / timed out
  | "unknown_outcome" // submitted, but the outcome could not be established
  | "unknown"; // any other definite pre-submission failure

export type TxErrorInfo = {
  kind: TxErrorKind;
  /** Fixed, user-safe sentence. Never a raw provider string. */
  message: string;
  /** True when the transaction may already be on-chain and must not be re-sent. */
  mayHaveSubmitted: boolean;
  /** A short, actionable recovery hint, when one exists. */
  action?: string;
};

/** An execution error as thrown by `lib/execution/execute.ts` (structurally). */
export type ExecutionErrorLike = { code?: string; message?: string };

/**
 * The specific, actionable message shown when the sender has enough MON for the
 * transfer amount but not for the amount *plus* the required maximum gas fee.
 *
 * This is deliberately distinct from the generic "Transaction error" the user
 * saw: it names the real cause (the fee), states the exact condition (balance
 * may cover the amount, but the fee also has to fit), and gives two concrete
 * remedies. It prints no fee figure, so it cannot be a misleading estimate, and
 * it is only ever used when a balance check established this exact shortfall —
 * never for a wallet rejection, an RPC failure, an unsupported asset, an invalid
 * recipient or a reverted transaction.
 */
export const INSUFFICIENT_MON_FOR_FEES_MESSAGE =
  "Insufficient MON for network fees. Your balance may cover the transfer amount, but you also need enough MON to cover the transaction fee. Reduce the transfer amount or add MON to your wallet.";

/**
 * Substitute an established fee-shortfall message into a readiness result
 * *without* changing its `code`. The readiness gate (and the Confirm button it
 * drives) must keep treating this as `insufficient_gas`; only the copy the user
 * reads changes. The canonical signal is `code === "insufficient_gas"`; both
 * readiness branches that can yield it already carry the canonical message, and
 * `isFeeShortfall` lets a caller with the raw balance checks reach the same
 * conclusion. A result that is not a fee shortfall is returned untouched.
 */
export function withFeeShortfallMessage<T extends { ready: boolean; code: string; message?: string }>(
  readiness: T,
): T {
  if (readiness.ready || readiness.code !== "insufficient_gas") return readiness;
  return { ...readiness, message: INSUFFICIENT_MON_FOR_FEES_MESSAGE };
}

/** The two balance checks the composer runs, reduced to what a fee shortfall needs. */
export type FeeShortfallSource = {
  sufficiency: { status: "ok" | "insufficient" | "unknown"; cause?: "amount" | "fees" };
  gasSufficiency: { status: "ok" | "insufficient" | "unknown" };
};

/**
 * True when the validation result establishes a *native-MON fee* shortfall: the
 * wallet covers the transfer amount but not the amount plus the required maximum
 * gas fee. This is the only condition under which the fee-shortfall copy may be
 * shown, so the primary error and the secondary composer warning cannot drift.
 *
 * It deliberately does not fire for an ordinary transfer-balance shortfall
 * (`cause: "amount"`), nor for any unrelated failure — those never reach here.
 */
export function isFeeShortfall(source: FeeShortfallSource): boolean {
  const { sufficiency, gasSufficiency } = source;
  if (sufficiency.status === "insufficient" && sufficiency.cause === "fees") return true;
  return gasSufficiency.status === "insufficient";
}

function textOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const parts = [e.shortMessage, e.message, e.details, e.cause].filter(
      (p): p is string => typeof p === "string",
    );
    return parts.join(" ");
  }
  return "";
}

function numericCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const c = (err as { code?: unknown }).code;
  if (typeof c === "number") return c;
  const nested = (err as { cause?: unknown }).cause;
  if (nested && typeof nested === "object" && typeof (nested as { code?: unknown }).code === "number") {
    return (nested as { code: number }).code;
  }
  return undefined;
}

/** Classify any thrown value into a small, honest set of outcomes. */
export function classifyTransactionError(err: unknown): TxErrorInfo {
  const code = numericCode(err);
  const text = textOf(err).toLowerCase();
  const executionCode = (err as ExecutionErrorLike)?.code;

  // The execution layer's own codes are authoritative when present.
  if (executionCode === "rejected" || code === 4001 || /user rejected|denied transaction/.test(text)) {
    return {
      kind: "rejected",
      message: "The transaction was cancelled in your wallet. No further transaction was submitted.",
      mayHaveSubmitted: false,
    };
  }

  // A swap that could not meet its on-chain minimum output (or maximum input)
  // reverts. Getting here without the on-chain revert is usually a simulation-
  // before-send failure, so we map it to a specific, actionable message rather
  // than the generic "reverted". Checked before the generic revert below.
  if (
    /insufficient output amount|insufficient input amount|too little received|amountoutminimum|amountinmaximum|minimum received|slippage|price moved|transferhelper/i.test(
      text,
    )
  ) {
    return {
      kind: "slippage",
      message:
        "The expected output could not be met within your slippage settings. Refresh the quote and review it before trying again.",
      mayHaveSubmitted: false,
      action: "Refresh quote",
    };
  }

  if (executionCode === "reverted" || /reverted|execution reverted/.test(text)) {
    return {
      kind: "reverted",
      message: "The transaction reverted on-chain. Review the transaction details before trying again.",
      mayHaveSubmitted: false,
    };
  }
  if (executionCode === "submitted") {
    return {
      kind: "unknown_outcome",
      message:
        "We could not confirm whether the transaction completed. Check the transaction status before submitting another payment.",
      mayHaveSubmitted: true,
      action: "Check status",
    };
  }

  // Gas: the wallet cannot cover the network fee in MON. A swap payment is
  // several sequential transactions, so the fee the wallet must cover is the
  // total for all of them. This is a real, established fee shortfall, so it gets
  // the specific, actionable message — never a generic "Transaction error".
  if (/insufficient funds for gas|gas required exceeds|intrinsic gas too low|exceeds the balance/.test(text)) {
    return {
      kind: "insufficient_gas",
      message: INSUFFICIENT_MON_FOR_FEES_MESSAGE,
      mayHaveSubmitted: false,
    };
  }
  if (/insufficient funds|insufficient balance|transfer amount exceeds balance/.test(text)) {
    return {
      kind: "insufficient_funds",
      message: "Your wallet does not have enough of the asset being spent for this payment.",
      mayHaveSubmitted: false,
    };
  }

  // Quote / route conditions.
  if (/stale|expired quote|quote expired/.test(text)) {
    return {
      kind: "expired_quote",
      message:
        "This payment quote has expired. Refresh the quote and review the updated payment details before authorizing.",
      mayHaveSubmitted: false,
      action: "Refresh quote",
    };
  }
  if (
    /route_unavailable|no route|no executable route|no supported liquidity route|liquidity route|unsupported_token|unsupported token/.test(
      text,
    )
  ) {
    return {
      kind: "no_route",
      message:
        "No executable payment route is currently available for this payment. Try another supported asset or amount.",
      mayHaveSubmitted: false,
    };
  }

  // Node reachability.
  if (
    /network error|failed to fetch|timeout|timed out|fetch failed|gateway|-32000|-32603|rate limit|too many requests/.test(
      text,
    ) ||
    code === -32000 ||
    code === -32603
  ) {
    return {
      kind: "rpc_unavailable",
      message:
        "We could not verify the transaction status because the network provider is temporarily unavailable. Your transaction may still be processing. Check its status before attempting another payment.",
      mayHaveSubmitted: true,
      action: "Check status",
    };
  }

  return {
    kind: "unknown",
    message: "The payment could not be completed. Review the details and try again.",
    mayHaveSubmitted: false,
  };
}
