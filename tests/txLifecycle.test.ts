import { describe, expect, it } from "vitest";
import {
  stateForStep,
  resolveSubmissionState,
  mayBeOnChain,
  isDefiniteFailure,
  isConfirmed,
  isUnknownOutcome,
  type TransactionState,
} from "@/lib/domain/txLifecycle";

/**
 * The explicit payment lifecycle. The point of these states is that a timeout
 * or a transport fault *after* a submission was attempted is NOT a failure:
 * the transaction may be on-chain, so recovery must check before re-sending.
 */
describe("resolveSubmissionState", () => {
  it("a confirmed receipt is CONFIRMED and wins over every other signal", () => {
    expect(resolveSubmissionState({ attempted: true, hasHash: true, confirmed: true })).toBe("CONFIRMED");
    // Even if a late error is reported alongside, a receipt is the truth.
    expect(resolveSubmissionState({ attempted: true, hasHash: true, confirmed: true, uncertain: true })).toBe(
      "CONFIRMED",
    );
  });

  it("a reverted receipt is REVERTED", () => {
    expect(resolveSubmissionState({ attempted: true, hasHash: true, reverted: true })).toBe("REVERTED");
  });

  it("a user rejection is a DEFINITIVE_FAILURE (nothing was broadcast)", () => {
    expect(resolveSubmissionState({ attempted: true, rejected: true })).toBe("DEFINITIVE_FAILURE");
  });

  it("a returned hash is SUBMITTED", () => {
    expect(resolveSubmissionState({ attempted: true, hasHash: true })).toBe("SUBMITTED");
  });

  it("an attempted submission with an unresolved outcome is UNKNOWN, never a failure", () => {
    expect(resolveSubmissionState({ attempted: true, uncertain: true })).toBe("SUBMISSION_UNKNOWN");
    expect(isDefiniteFailure("SUBMISSION_UNKNOWN")).toBe(false);
    expect(isUnknownOutcome("SUBMISSION_UNKNOWN")).toBe(true);
  });

  it("a never-attempted call is a DEFINITIVE_FAILURE (safe to retry)", () => {
    expect(resolveSubmissionState({ attempted: false, hasHash: false })).toBe("DEFINITIVE_FAILURE");
    expect(isDefiniteFailure("DEFINITIVE_FAILURE")).toBe(true);
  });
});

describe("mayBeOnChain", () => {
  it("is true for every state at or beyond a submission attempt", () => {
    const onChain: TransactionState[] = [
      "SUBMISSION_ATTEMPTED",
      "SUBMISSION_UNKNOWN",
      "SUBMITTED",
      "CONFIRMATION_PENDING",
      "CONFIRMED",
      "REVERTED",
    ];
    for (const s of onChain) expect(mayBeOnChain(s)).toBe(true);
  });

  it("is false only before the wallet was asked", () => {
    for (const s of ["PREPARED", "AWAITING_WALLET_APPROVAL", "DEFINITIVE_FAILURE"] as TransactionState[]) {
      expect(mayBeOnChain(s)).toBe(false);
    }
  });

  it("isConfirmed is true only for CONFIRMED", () => {
    expect(isConfirmed("CONFIRMED")).toBe(true);
    expect(isConfirmed("SUBMITTED")).toBe(false);
    expect(isConfirmed("SUBMISSION_UNKNOWN")).toBe(false);
  });
});

describe("stateForStep", () => {
  it("maps the reported step shape onto the lifecycle", () => {
    expect(stateForStep({ status: "pending" })).toBe("PREPARED");
    expect(stateForStep({ status: "submitted", hash: "0x1" })).toBe("SUBMITTED");
    expect(stateForStep({ status: "submitted", hash: "0x1", unconfirmed: true })).toBe("SUBMISSION_UNKNOWN");
    expect(stateForStep({ status: "confirmed", hash: "0x1" })).toBe("CONFIRMED");
    // A failed step with a hash was broadcast; one without never left the wallet.
    expect(stateForStep({ status: "failed", hash: "0x1" })).toBe("REVERTED");
    expect(stateForStep({ status: "failed" })).toBe("DEFINITIVE_FAILURE");
  });

  it("agrees with mayBeOnChain: a failed step carrying a hash must not be retried blindly", () => {
    expect(mayBeOnChain(stateForStep({ status: "failed", hash: "0x1" }))).toBe(true);
    expect(mayBeOnChain(stateForStep({ status: "failed" }))).toBe(false);
    expect(mayBeOnChain(stateForStep({ status: "submitted", hash: "0x1", unconfirmed: true }))).toBe(true);
  });
});
