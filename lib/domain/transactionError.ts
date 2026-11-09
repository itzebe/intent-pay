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
  | "wallet_rpc" // the wallet's own provider could not complete its network call
  | "unsupported" // the wallet cannot submit a transaction from this app
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

/**
 * Collect every human-readable fragment from an error *and its `cause` chain*.
 *
 * The execution layer wraps a wallet/RPC failure in its own `ExecutionError`
 * and preserves the original value on `.cause`. Reading only the wrapper's
 * fixed sentence would discard the real reason (a gas shortfall, a simulation
 * revert, a user rejection) and force the generic fallback — exactly the
 * "Transaction error" a small payment used to show. viem nests its own causes
 * several levels deep (`BaseError.cause` → provider error → …), so we walk the
 * chain a bounded number of levels.
 */
function textOf(err: unknown): string {
  const parts: string[] = [];
  let node: unknown = err;
  for (let depth = 0; depth < 6 && node != null; depth++) {
    if (typeof node === "string") {
      parts.push(node);
      break;
    }
    if (typeof node !== "object") break;
    const e = node as Record<string, unknown>;
    for (const key of ["shortMessage", "message", "details", "reason"]) {
      const v = e[key];
      if (typeof v === "string" && v) parts.push(v);
    }
    node = e.cause;
  }
  return parts.join(" ");
}

/** The first numeric JSON-RPC / EIP-1193 code found along the `cause` chain. */
function numericCode(err: unknown): number | undefined {
  let node: unknown = err;
  for (let depth = 0; depth < 6 && node && typeof node === "object"; depth++) {
    const c = (node as { code?: unknown }).code;
    if (typeof c === "number") return c;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * True when any message along the `cause` chain looks like a transport failure.
 *
 * The connection-failure family matters as much as `fetch failed`: a wallet
 * provider that reaches its own node over HTTP surfaces a *connection* error,
 * not a `fetch` one. Trust Wallet's in-app browser is the concrete case — its
 * native layer reports `Failed to connect to http://monad.twnodes.com/` when it
 * cannot reach its own NaaS RPC. Without these shapes that raw phrase falls
 * through to the generic fallback, so the user is never told the transaction may
 * already be on-chain.
 */
export function isTransportError(err: unknown): boolean {
  const text = textOf(err).toLowerCase();
  return (
    /failed to fetch/.test(text) ||
    /networkerror/.test(text) ||
    /network request failed/.test(text) ||
    /load failed/.test(text) ||
    /fetch failed/.test(text) ||
    // Connection refused / unreachable / DNS — a provider talking to its own node.
    /failed to connect/.test(text) ||
    /could not connect|couldn't connect|unable to connect/.test(text) ||
    /connection refused|connection reset|connection closed|connection error/.test(text) ||
    /net::err_/.test(text) ||
    /err_connection|err_name_not_resolved|err_address_unreachable|err_network_changed/.test(text) ||
    /network is unreachable|host is unreachable|no route to host/.test(text) ||
    // Node/undici errno spellings of the same failures.
    /econnrefused|econnreset|enotfound|eai_again|etimedout|epipe|enetunreach|ehostunreach/.test(text) ||
    /socket hang up|other side closed/.test(text) ||
    /timed out|timeout/.test(text)
  );
}

/**
 * True when a thrown value is the *wallet's* provider failing its own network
 * request — not an Intent Pay RPC read.
 *
 * The execution layer marks a **submission** failure with the step id and keeps
 * the wallet's original thrown value on `cause` (`lib/execution/execute.ts`).
 * Our own chain reads (quote, balances, gas, receipt wait) are made through our
 * HTTPS clients and are either handled internally or fail without a step id.
 * So a transport-shaped failure that carries a step id is the wallet provider —
 * never our RPC being down. (The outcome is still treated as *unknown*, because
 * the failure happens after the user authorised and may not prove nothing was
 * broadcast; see `classifyTransactionError`.)
 */
export function isWalletTransportFailure(err: unknown): boolean {
  const e = err as { stepId?: unknown; cause?: unknown } | undefined;
  if (!e || typeof e !== "object" || !e.stepId) return false;
  return isTransportError(e.cause ?? e);
}

/** Classify any thrown value into a small, honest set of outcomes. */
export function classifyTransactionError(
  err: unknown,
  options: { source?: "app" | "wallet" } = {},
): TxErrorInfo {
  const code = numericCode(err);
  const text = textOf(err).toLowerCase();
  const executionCode = (err as ExecutionErrorLike)?.code;
  // A transport failure raised while the *wallet's* provider was doing its own
  // network work is a different fact from our own RPC being unreachable: our
  // chain reads (quote, balances, gas, receipts) are independent of it and keep
  // working. The caller that knows which side failed passes `source: "wallet"`.
  const walletSource = options.source === "wallet";

  // The execution layer's own codes are authoritative when present.
  if (executionCode === "rejected" || code === 4001 || /user rejected|denied transaction/.test(text)) {
    return {
      kind: "rejected",
      message: "The transaction was cancelled in your wallet. No further transaction was submitted.",
      mayHaveSubmitted: false,
    };
  }

  // The wallet cannot submit a transaction at all (EIP-1193 4200 / -32601). This
  // is a definite pre-submission failure — nothing was broadcast — so it keeps a
  // usable retry and a specific, honest message rather than the ambiguous
  // unknown-outcome treatment.
  if (code === 4200 || code === -32601) {
    return {
      kind: "unsupported",
      message:
        "This wallet cannot submit a transaction from this app. Try a different wallet, or use the same wallet in a browser.",
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
  // Checked *before* the generic "insufficient funds" branch below, because
  // wallets phrase the fee shortfall as an "insufficient funds for …" message
  // too, and misreading it as a token shortfall would send the user to the
  // wrong remedy.
  if (
    /insufficient funds for gas|insufficient funds for intrinsic|gas required exceeds|intrinsic gas too low|exceeds the balance|out of gas|gas \* price \+ value/.test(
      text,
    )
  ) {
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

  // Node reachability. The shape test is the single `isTransportError` rule, so
  // a connection-refused/DNS failure (a wallet talking to its own node) is
  // recognised here too — never left to the generic fallback.
  if (
    isTransportError(err) ||
    /network error|gateway|rate limit|too many requests/.test(text) ||
    code === -32000 ||
    code === -32603
  ) {
    // A transport failure the *wallet* hit is not our RPC being down: our own
    // quote, balance, gas and receipt reads are independent and keep working.
    //
    // But it is NOT safe to claim "the transaction was not sent": the wallet is
    // asked to send only *after* the user has authorised, so the wallet may
    // already have signed and broadcast before its transport to its own node
    // failed. Trust Wallet's in-app browser raises exactly this — it opens its
    // native approval, the user enters their password, and only then does its
    // native layer report `Failed to connect to http://monad.twnodes.com/`. That
    // error does not prove nothing was broadcast, so the outcome is unknown: keep
    // any hash we hold, do not resubmit, and offer a status check.
    if (walletSource) {
      return {
        kind: "wallet_rpc",
        message:
          "Your wallet authorised the payment but could not reach its own network endpoint, so we can't confirm whether the transaction was broadcast. It may already be on Monad. Do not submit another payment — check the transaction status first.",
        mayHaveSubmitted: true,
        action: "Check status",
      };
    }
    return {
      kind: "rpc_unavailable",
      message:
        "We could not verify the transaction status because the network provider is temporarily unavailable. Your transaction may still be processing. Check its status before attempting another payment.",
      mayHaveSubmitted: true,
      action: "Check status",
    };
  }

  // A submission-step failure we cannot pin to a specific cause. The execution
  // layer tags it with the failing step id, which proves the wallet WAS asked to
  // send — and the wallet is asked only after the user authorised. So the raw
  // message ("Transaction error", "Unknown error", a bare -32603, …) does not
  // establish that nothing was broadcast. Reporting it as a definite
  // pre-submission failure (the generic fallback) both hides the real situation
  // and offers a plain Retry, which can double-spend. Treat it as an unknown
  // outcome: keep any hash, do not resubmit, and offer a read-only status check.
  const stepTagged = (err as { stepId?: unknown } | undefined)?.stepId;
  if (stepTagged) {
    return {
      kind: "unknown_outcome",
      message:
        "We could not confirm whether the transaction completed. Check the transaction status before submitting another payment.",
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
