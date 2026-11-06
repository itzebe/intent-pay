/**
 * The explicit lifecycle of one on-chain payment submission.
 *
 * A timeout — or a wallet/RPC error raised *after* a submission was attempted —
 * does not prove the transaction was not broadcast. Collapsing that ambiguity
 * into a plain "failed" is how a customer is told a payment failed while it is
 * in fact confirming, and how a Retry double-spends.
 *
 * These states make the distinction explicit and are the single vocabulary the
 * composer, the checkout and the recovery UI use. They are a *refinement* of the
 * existing model (`StepResult.status`, `ExecutionError.code`, the attempt
 * stages), not a second store: `resolveSubmissionState` maps the signals those
 * layers already produce onto exactly one state.
 */

export type TransactionState =
  /** The transaction is built and validated; the wallet has not been asked yet. */
  | "PREPARED"
  /** The wallet approval prompt is open (or about to be) — nothing is signed yet. */
  | "AWAITING_WALLET_APPROVAL"
  /** `eth_sendTransaction` has been handed to the wallet; no result yet. */
  | "SUBMISSION_ATTEMPTED"
  /** Submission was attempted but its outcome could not be established. */
  | "SUBMISSION_UNKNOWN"
  /** The wallet returned a hash — the transaction is broadcast. */
  | "SUBMITTED"
  /** Broadcast; awaiting a receipt within the confirmation window. */
  | "CONFIRMATION_PENDING"
  /** A successful receipt was observed. */
  | "CONFIRMED"
  /** The transaction reverted on-chain. */
  | "REVERTED"
  /** A definite pre-submission failure (rejected, not sent, unsupported). */
  | "DEFINITIVE_FAILURE";

/**
 * States in which the transaction may already be on-chain (or is confirmed).
 * Recovery must never resubmit blindly from any of these — it must first check
 * whether the original transaction was accepted.
 */
const MAY_BE_ON_CHAIN: ReadonlySet<TransactionState> = new Set<TransactionState>([
  "SUBMISSION_ATTEMPTED",
  "SUBMISSION_UNKNOWN",
  "SUBMITTED",
  "CONFIRMATION_PENDING",
  "CONFIRMED",
  "REVERTED",
]);

/** True when the transaction may already be on-chain; never resubmit blindly. */
export function mayBeOnChain(state: TransactionState): boolean {
  return MAY_BE_ON_CHAIN.has(state);
}

/** True only for a definite pre-submission failure (safe to offer a fresh send). */
export function isDefiniteFailure(state: TransactionState): boolean {
  return state === "DEFINITIVE_FAILURE";
}

/** True only when a successful receipt was observed. */
export function isConfirmed(state: TransactionState): boolean {
  return state === "CONFIRMED";
}

/** True when the outcome could not be established — neither success nor failure. */
export function isUnknownOutcome(state: TransactionState): boolean {
  return state === "SUBMISSION_UNKNOWN";
}

export type SubmissionSignals = {
  /** The wallet was asked to send (`eth_sendTransaction` was called). */
  attempted: boolean;
  /** The wallet returned a well-formed transaction hash. Defaults to false. */
  hasHash?: boolean;
  /** The user declined in the wallet (EIP-1193 4001). */
  rejected?: boolean;
  /** The transaction was mined with a reverted status. */
  reverted?: boolean;
  /** A successful receipt was observed. */
  confirmed?: boolean;
  /**
   * A submission error occurred that does not prove the transaction was *not*
   * broadcast (a transport fault, a timeout, an RPC error after send).
   */
  uncertain?: boolean;
};

/**
 * Resolve exactly one lifecycle state from the signals the execution layers
 * already produce. Order matters: a confirmed receipt wins over everything; a
 * user rejection is a definite failure *only* when nothing was broadcast; an
 * attempted-but-unresolved submission is unknown, never a definite failure.
 */
export function resolveSubmissionState(signals: SubmissionSignals): TransactionState {
  if (signals.confirmed) return "CONFIRMED";
  if (signals.reverted) return "REVERTED";
  if (signals.rejected) return "DEFINITIVE_FAILURE";
  if (signals.hasHash) return "SUBMITTED";
  if (signals.attempted && signals.uncertain) return "SUBMISSION_UNKNOWN";
  if (signals.attempted) return "SUBMISSION_ATTEMPTED";
  return "DEFINITIVE_FAILURE";
}

/** The shape `executePlan` reports per step (structurally, no import cycle). */
export type StepSignal = {
  status: "pending" | "submitted" | "confirmed" | "failed";
  hash?: string;
  unconfirmed?: boolean;
};

/**
 * Map one reported step onto the lifecycle — the single source for "may this
 * step already be on-chain?". A `failed` step that still carries a hash was
 * broadcast (a revert or an unresolved send); a `failed` step with no hash never
 * left the wallet. Callers must not reimplement this test.
 */
export function stateForStep(s: StepSignal): TransactionState {
  if (s.status === "confirmed") return "CONFIRMED";
  if (s.status === "submitted") return s.unconfirmed ? "SUBMISSION_UNKNOWN" : "SUBMITTED";
  if (s.status === "failed") return s.hash ? "REVERTED" : "DEFINITIVE_FAILURE";
  return "PREPARED";
}
