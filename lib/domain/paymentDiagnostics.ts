/**
 * Structured, secret-free diagnostics for the Confirm-and-Send path.
 *
 * The reported symptom — the interface returns to "Confirm and Send" with no
 * useful explanation — was impossible to attribute because no stage information
 * survived the failure. This records, for every failure, the exact stage, the
 * normalized code, whether the wallet rejected, whether a transaction hash
 * existed, and whether the operation may already have been submitted (so Retry
 * must track it rather than resubmit).
 *
 * It deliberately carries NO private keys, seed phrases, signatures, auth
 * tokens, or environment values. The record is built purely and emitted to the
 * console (visible in DevTools and in the collapsed Advanced diagnostics) —
 * it is never sent to a server from here.
 */

export type PaymentStage =
  | "payment_submit_started"
  | "wallet_connection_checked"
  | "chain_validation_completed"
  | "receipt_polling_started"
  | "payment_execution_verified"
  | "payment_failed";

/** A fixed, ordered list of the stages this app can actually reach. */
export const PAYMENT_STAGES: readonly PaymentStage[] = [
  "payment_submit_started",
  "wallet_connection_checked",
  "chain_validation_completed",
  "receipt_polling_started",
  "payment_execution_verified",
] as const;

export type PaymentDiagnostic = {
  event: PaymentStage;
  /** Normalized reason/error code (e.g. "account_changed", "rejected"). */
  code?: string;
  /** A user-safe message. Never a raw stack trace or provider secret. */
  message?: string;
  /** Did the wallet explicitly reject the request? */
  walletRejected?: boolean;
  /** A transaction hash exists (an on-chain tx was produced). */
  hasTransactionHash?: boolean;
  /** The operation may already have been submitted — Retry must not resubmit. */
  mayHaveSubmitted?: boolean;
  /** Did the UI return to (or stay on) the confirmation/Review state? */
  returnedToConfirm?: boolean;
  /** Wall-clock time (ms) the diagnostic was produced. */
  at: number;
};

export function buildPaymentDiagnostic(
  input: Omit<PaymentDiagnostic, "at"> & { at?: number },
): PaymentDiagnostic {
  return { at: input.at ?? Date.now(), ...input };
}

function safeMessage(message: string | undefined): string | undefined {
  if (!message) return undefined;
  // Cap length and strip control characters so a pathological provider string
  // can never dump a stack or flood the console.
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

/**
 * Emit a diagnostic. Console-only and secret-free by construction. A no-op in
 * non-browser environments so importing this is safe during SSR and tests.
 */
export function recordPaymentDiagnostic(diag: PaymentDiagnostic): void {
  if (typeof console === "undefined") return;
  const { event, code, message, walletRejected, hasTransactionHash, mayHaveSubmitted, returnedToConfirm, at } =
    diag;
  console.warn(
    JSON.stringify({
      level: "warn",
      scope: "payment",
      event,
      code,
      message: safeMessage(message),
      walletRejected: walletRejected ?? false,
      hasTransactionHash: hasTransactionHash ?? false,
      mayHaveSubmitted: mayHaveSubmitted ?? false,
      returnedToConfirm: returnedToConfirm ?? false,
      at,
    }),
  );
}
