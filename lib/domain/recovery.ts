/**
 * Evidence-based transaction recovery after an *unknown* submission outcome.
 *
 * A post-authorisation failure (Trust Wallet's native layer reporting it cannot
 * reach `monad.twnodes.com`, a timeout, a mid-flight RPC error) does not prove
 * the transaction was not broadcast. PR #47 correctly refused to call that a
 * failure — but its recovery leaned on two heuristics that are **clues, not
 * proof**:
 *
 *   * a pending nonce that advanced was read as "this payment was broadcast",
 *   * a pending nonce that did not advance was read as "nothing was broadcast".
 *
 * Neither is sound on a public chain. An unrelated transaction on the same
 * account advances the nonce; a broadcast transaction may be invisible to one
 * node's mempool while another has it; and `pending` is a per-node view, not a
 * chain fact. This module replaces those guesses with a small set of *evidence
 * reads* and one honest classification:
 *
 *   CONFIRMED          a receipt for our hash proves successful execution,
 *   REVERTED           a receipt for our hash proves it reverted,
 *   SUBMITTED          our hash is independently visible but not yet confirmed,
 *   SUBMISSION_UNKNOWN the reads cannot establish what happened,
 *   DEFINITIVE_FAILURE a rejection / pre-submission failure proves nothing was sent.
 *
 * The rule that matters most: **a nonce reading never decides the outcome.** A
 * nonce that advanced without a matching transaction is reported as
 * SUBMISSION_UNKNOWN ("activity advanced, but it cannot be attributed to this
 * payment"), never as SUBMITTED; a nonce that did not advance is never treated
 * as proof that nothing was sent. Only a receipt, a matching transaction, or an
 * explicit pre-submission refusal produces a definite answer.
 *
 * The module is pure (no viem, no React, no I/O): the caller injects the reads
 * (`lib/execution/recoveryClient.ts` wires them to the app's own HTTPS RPC). That
 * makes every branch — including cross-endpoint disagreement — unit-testable.
 */

/** The transaction fields a chain read exposes, narrowed to what matching needs. */
export type RecoveredTx = {
  from?: string | null;
  to?: string | null;
  nonce?: string | number | bigint | null;
  value?: string | number | bigint | null;
  /** The calldata (`input`). */
  input?: string | null;
};

/** The receipt fields a chain read exposes, narrowed to what classification needs. */
export type RecoveredReceipt = { status?: string | null } | null;

/** One independent RPC node's view. Several are combined for corroboration. */
export type RecoveryEndpointReads = {
  /** A human label for diagnostics only (never a URL the user sees). */
  label: string;
  /** The receipt for one hash, or null when this node has not indexed it. */
  getTransactionReceipt: (hash: `0x${string}`) => Promise<RecoveredReceipt>;
  /** The transaction for one hash, or null when this node does not know it. */
  getTransaction: (hash: `0x${string}`) => Promise<RecoveredTx | null>;
  /** The account nonce. `latest` = mined, `pending` = mined + this node's mempool. */
  getTransactionCount: (blockTag: "latest" | "pending") => Promise<bigint>;
};

/** The set of reads used for one recovery: the account plus every configured node. */
export type RecoveryReads = {
  account: `0x${string}`;
  endpoints: RecoveryEndpointReads[];
};

/**
 * The exact transaction the app asked the wallet to send, so a candidate found
 * on chain can be matched field-by-field. Only the fields the app controlled are
 * used; anything absent is simply not asserted.
 */
export type AttemptIdentity = {
  from: `0x${string}`;
  to?: `0x${string}`;
  nonce?: bigint;
  value?: bigint;
  data?: `0x${string}`;
  /** The account nonce observed immediately before the attempt, when available. */
  baselineNonce?: bigint;
};

/** How a candidate transaction relates to the attempted one. */
export type CandidateMatch = "match" | "conflict" | "unknown";

function normHex(v: string | null | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.toLowerCase();
  // An absent/empty calldata is "0x" (or undefined) — normalise both to "0x".
  return s === "" ? "0x" : s;
}

function sameAddress(a: string | null | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function toBig(v: string | number | bigint | null | undefined): bigint | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  try {
    return v.startsWith("0x") ? BigInt(v) : BigInt(v);
  } catch {
    return undefined;
  }
}

/**
 * Does an on-chain transaction correspond to the one we attempted?
 *
 * `conflict` is returned as soon as a field the app controlled disagrees — that
 * is how an *unrelated* transaction (a different recipient, a different nonce,
 * different calldata) is told apart from ours. A field we cannot read is not
 * asserted: if nothing disagrees but something is missing we report `unknown`,
 * never a false `match`.
 */
export function matchCandidate(tx: RecoveredTx | null, attempt: AttemptIdentity): CandidateMatch {
  if (!tx) return "unknown";
  // The sender must be our account — a transaction from another account is
  // never this payment.
  if (tx.from && !sameAddress(tx.from, attempt.from)) return "conflict";
  const unknown: boolean[] = [];
  if (attempt.to !== undefined) {
    if (!tx.to) unknown.push(true);
    else if (!sameAddress(tx.to, attempt.to)) return "conflict";
  }
  if (attempt.nonce !== undefined) {
    const n = toBig(tx.nonce);
    if (n === undefined) unknown.push(true);
    else if (n !== attempt.nonce) return "conflict";
  }
  if (attempt.value !== undefined) {
    const v = toBig(tx.value);
    if (v === undefined) unknown.push(true);
    else if (v !== attempt.value) return "conflict";
  }
  if (attempt.data !== undefined) {
    const inp = normHex(tx.input);
    if (inp === undefined) unknown.push(true);
    else if (inp !== attempt.data.toLowerCase()) return "conflict";
  }
  return unknown.length > 0 ? "unknown" : "match";
}

export type RecoveryOutcome =
  | { state: "CONFIRMED"; hash: `0x${string}` }
  | { state: "REVERTED"; hash: `0x${string}` }
  | { state: "SUBMITTED"; hash: `0x${string}`; confirmationsSeen: number }
  | { state: "SUBMISSION_UNKNOWN"; reason: string; activityAdvanced: boolean }
  | { state: "DEFINITIVE_FAILURE"; reason: string };

export type RecoveryResult = {
  outcome: RecoveryOutcome;
  /** A user-safe sentence describing the evidence, never a raw provider string. */
  message: string;
  /** True only when the outcome positively proves nothing was submitted. */
  safeToRetry: boolean;
  /** A non-empty hash justifies an explorer link; empty means "no hash". */
  hash?: `0x${string}`;
  /** Secret-free trail of what each read returned, for the console diagnostic. */
  evidence: string[];
};

/** The single user-facing copy for the unknown-outcome heading. */
export const PAYMENT_STATUS_NEEDS_CHECKING_TITLE = "Payment status needs checking";

/**
 * The single user-facing sentence for an outcome that could not be established.
 * Used verbatim by the composer and the checkout so the two cannot drift.
 */
export const SUBMISSION_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your wallet submitted this payment. Check its status before trying again. This helps prevent duplicate payments.";

/** Shown when the account's activity advanced but cannot be attributed to us. */
export const ACTIVITY_ADVANCED_MESSAGE =
  "We couldn't confirm whether your wallet submitted this payment, and your account's activity has changed since. That activity may not be this payment, so don't submit another one until you have checked. This helps prevent duplicate payments.";

/**
 * Recover the true state of a submission whose outcome is unknown.
 *
 * `hashes` is every hash the wallet actually returned (usually none for the
 * post-authorisation Trust Wallet failure). Reads are attempted hash-first: with
 * a hash we can look the transaction up directly; without one we can only read
 * the account's nonce, which — deliberately — never decides the outcome.
 */
export async function recoverSubmission(input: {
  reads: RecoveryReads;
  attempt: AttemptIdentity;
  hashes: `0x${string}`[];
  /** Set when the wallet refused before sending (EIP-1193 4001). */
  rejected?: boolean;
  /** Set when a pre-submission failure is already established. */
  preSubmissionFailure?: boolean;
}): Promise<RecoveryResult> {
  const { reads, attempt, hashes } = input;
  const evidence: string[] = [];
  const endpoints = reads.endpoints.length > 0 ? reads.endpoints : [];

  // A rejection or an established pre-submission failure is the only *definite*
  // answer, and it is known without any chain read. Nothing was broadcast.
  if (input.rejected) {
    return {
      outcome: { state: "DEFINITIVE_FAILURE", reason: "rejected" },
      message: "The payment was declined in your wallet. Nothing was submitted, so you can safely try again.",
      safeToRetry: true,
      evidence: ["wallet returned a user rejection"],
    };
  }
  if (input.preSubmissionFailure) {
    return {
      outcome: { state: "DEFINITIVE_FAILURE", reason: "pre_submission" },
      message: "The wallet could not submit the payment. Nothing was sent, so you can safely try again.",
      safeToRetry: true,
      evidence: ["pre-submission failure"],
    };
  }

  // 1. A hash is the strongest evidence: look the receipt (then the tx) up on
  //    every endpoint. A single non-null receipt is authoritative — a reverted
  //    receipt and a successful one are both *proof* of what happened.
  let sawRevert: `0x${string}` | undefined;
  const visibleHashes: `0x${string}`[] = [];
  for (const hash of hashes) {
    let receiptFound = false;
    let txVisible = false;
    for (const ep of endpoints) {
      let receipt: RecoveredReceipt = null;
      try {
        receipt = await ep.getTransactionReceipt(hash);
      } catch {
        receipt = null;
      }
      if (receipt) {
        receiptFound = true;
        evidence.push(`${ep.label}: receipt for ${hash} => ${receipt.status ?? "unknown"}`);
        if (receipt.status === "reverted") sawRevert = hash;
        else return {
          outcome: { state: "CONFIRMED", hash },
          message: "Your payment was confirmed on Monad.",
          safeToRetry: false,
          hash,
          evidence,
        };
      } else {
        evidence.push(`${ep.label}: no receipt for ${hash}`);
      }
    }
    if (!receiptFound) {
      // No receipt yet — is the transaction at least *visible* on a node?
      for (const ep of endpoints) {
        let tx: RecoveredTx | null = null;
        try {
          tx = await ep.getTransaction(hash);
        } catch {
          tx = null;
        }
        if (tx) {
          txVisible = true;
          const m = matchCandidate(tx, attempt);
          evidence.push(`${ep.label}: tx ${hash} visible (match=${m})`);
          // A visible transaction from a conflicting sender is *not* our payment.
          if (m !== "conflict") break;
        } else {
          evidence.push(`${ep.label}: tx ${hash} not found`);
        }
      }
    }
    if (txVisible) visibleHashes.push(hash);
  }

  if (sawRevert) {
    return {
      outcome: { state: "REVERTED", hash: sawRevert },
      message: "The transaction reverted on Monad. Nothing was delivered.",
      safeToRetry: false,
      hash: sawRevert,
      evidence,
    };
  }

  // A returned hash that no node has yet is still *submitted by definition* — the
  // wallet produced it after the user authorised. It is not yet confirmed.
  if (hashes.length > 0) {
    const hash = visibleHashes[0] ?? hashes[hashes.length - 1];
    return {
      outcome: { state: "SUBMITTED", hash, confirmationsSeen: 0 },
      message:
        "Your wallet returned a transaction hash, so the payment was broadcast. It is not confirmed yet — check its status; do not submit another payment.",
      safeToRetry: false,
      hash,
      evidence,
    };
  }

  // 2. No hash at all. The only thing left to read is the account's own nonce.
  //    This is a CLUE ONLY: an advanced nonce cannot be attributed to this
  //    payment (an unrelated transaction may have advanced it), and an unchanged
  //    nonce is not proof nothing was broadcast (a node's mempool view is local).
  let baseline = attempt.baselineNonce;
  let advanced = false;
  let readable = false;
  for (const ep of endpoints) {
    if (baseline === undefined) {
      // Without a baseline we cannot compare; try to establish one from `latest`
      // is not possible retroactively, so leave it undefined.
      break;
    }
    try {
      const latest = await ep.getTransactionCount("latest");
      const pending = await ep.getTransactionCount("pending").catch(() => latest);
      readable = true;
      const higher = pending > latest ? pending : latest;
      evidence.push(`${ep.label}: latest=${latest} pending=${pending} baseline=${baseline}`);
      if (higher > baseline) advanced = true;
    } catch {
      evidence.push(`${ep.label}: nonce read failed`);
    }
  }

  // Even when every endpoint agrees the nonce is unchanged we do NOT claim
  // nothing was sent: a dropped-from-view transaction is indistinguishable from
  // one that was never broadcast. The honest result is SUBMISSION_UNKNOWN.
  const reason = !readable
    ? "no_hash_no_readable_activity"
    : advanced
      ? "no_hash_activity_advanced"
      : "no_hash_activity_unchanged";
  return {
    outcome: { state: "SUBMISSION_UNKNOWN", reason, activityAdvanced: advanced },
    message: advanced ? ACTIVITY_ADVANCED_MESSAGE : SUBMISSION_UNKNOWN_MESSAGE,
    safeToRetry: false,
    evidence,
  };
}
