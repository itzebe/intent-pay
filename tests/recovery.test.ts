import { describe, expect, it } from "vitest";
import {
  matchCandidate,
  recoverSubmission,
  SUBMISSION_UNKNOWN_MESSAGE,
  ACTIVITY_ADVANCED_MESSAGE,
  type RecoveryEndpointReads,
  type RecoveredReceipt,
  type RecoveredTx,
} from "@/lib/domain/recovery";

/**
 * Evidence-based recovery (Mission 26).
 *
 * The point of these tests is that a nonce reading is a **clue, not proof**:
 * an advanced nonce is never read as "this payment was broadcast", and an
 * unchanged nonce is never read as "nothing was sent". Only a receipt, a
 * matching transaction, or an explicit pre-submission refusal produces a
 * definite answer. Each case below is named for the scenario it guards.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

const attempt = {
  from: SENDER,
  to: RECIPIENT,
  nonce: 7n,
  value: 5_000_000n,
  data: "0xdeadbeef" as `0x${string}`,
  baselineNonce: 7n,
};

/** A scriptable endpoint read. Defaults: nothing known, nonce unchanged. */
function endpoint(over: Partial<RecoveryEndpointReads> & { label: string }): RecoveryEndpointReads {
  return {
    label: over.label,
    getTransactionReceipt: over.getTransactionReceipt ?? (async () => null),
    getTransaction: over.getTransaction ?? (async () => null),
    getTransactionCount: over.getTransactionCount ?? (async () => 7n),
  };
}

function tx(over: Partial<RecoveredTx> = {}): RecoveredTx {
  return {
    from: SENDER,
    to: RECIPIENT,
    nonce: 7,
    value: 5_000_000n,
    input: "0xdeadbeef",
    ...over,
  };
}

const receipt = (status: string): RecoveredReceipt => ({ status });

describe("matchCandidate", () => {
  it("matches a transaction identical to the attempt", () => {
    expect(matchCandidate(tx(), attempt)).toBe("match");
  });

  it("conflicts when a field the app controlled differs (an unrelated tx)", () => {
    expect(matchCandidate(tx({ to: "0x2222222222222222222222222222222222222222" }), attempt)).toBe("conflict");
    expect(matchCandidate(tx({ nonce: 8 }), attempt)).toBe("conflict");
    expect(matchCandidate(tx({ value: 1n }), attempt)).toBe("conflict");
    expect(matchCandidate(tx({ input: "0xfeed" }), attempt)).toBe("conflict");
    expect(matchCandidate(tx({ from: "0x9999999999999999999999999999999999999999" }), attempt)).toBe("conflict");
  });

  it("is unknown (never a false match) when a field cannot be read", () => {
    expect(matchCandidate(tx({ nonce: null }), attempt)).toBe("unknown");
    expect(matchCandidate(null, attempt)).toBe("unknown");
  });
});

describe("recoverSubmission — definite outcomes", () => {
  it("case 1/2: a user rejection is a DEFINITIVE_FAILURE, safe to retry", async () => {
    const r = await recoverSubmission({ reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0" })] }, attempt, hashes: [], rejected: true });
    expect(r.outcome.state).toBe("DEFINITIVE_FAILURE");
    expect(r.safeToRetry).toBe(true);
  });

  it("a pre-submission failure is a DEFINITIVE_FAILURE, safe to retry", async () => {
    const r = await recoverSubmission({ reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0" })] }, attempt, hashes: [], preSubmissionFailure: true });
    expect(r.outcome.state).toBe("DEFINITIVE_FAILURE");
    expect(r.safeToRetry).toBe(true);
  });

  it("case 7: a successful receipt for our hash is CONFIRMED", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0", getTransactionReceipt: async () => receipt("success") })] },
      attempt,
      hashes: [HASH],
    });
    expect(r.outcome.state).toBe("CONFIRMED");
    expect(r.safeToRetry).toBe(false);
    expect(r.hash).toBe(HASH);
  });

  it("case 8: a reverted receipt for our hash is REVERTED", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0", getTransactionReceipt: async () => receipt("reverted") })] },
      attempt,
      hashes: [HASH],
    });
    expect(r.outcome.state).toBe("REVERTED");
    expect(r.safeToRetry).toBe(false);
  });

  it("case 4/6: a returned hash with no receipt yet is SUBMITTED (never a failure)", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0" })] },
      attempt,
      hashes: [HASH],
    });
    expect(r.outcome.state).toBe("SUBMITTED");
    expect(r.safeToRetry).toBe(false);
    expect(r.hash).toBe(HASH);
  });

  it("case 5: a returned error but the transaction is visible on chain → SUBMITTED", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0", getTransaction: async () => tx() })] },
      attempt,
      hashes: [HASH],
    });
    expect(r.outcome.state).toBe("SUBMITTED");
    expect(r.safeToRetry).toBe(false);
  });
});

describe("recoverSubmission — the nonce is a clue, never proof", () => {
  it("case 3: a post-authorisation failure with no hash and no activity is SUBMISSION_UNKNOWN, NOT a failure", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0", getTransactionCount: async () => 7n })] },
      attempt,
      hashes: [],
    });
    expect(r.outcome.state).toBe("SUBMISSION_UNKNOWN");
    expect(r.safeToRetry).toBe(false);
    expect(r.message).toBe(SUBMISSION_UNKNOWN_MESSAGE);
  });

  it("case 11: an unrelated transaction advances the nonce → still SUBMISSION_UNKNOWN, never SUBMITTED", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0", getTransactionCount: async () => 9n })] },
      attempt,
      hashes: [],
    });
    expect(r.outcome.state).toBe("SUBMISSION_UNKNOWN");
    if (r.outcome.state === "SUBMISSION_UNKNOWN") expect(r.outcome.activityAdvanced).toBe(true);
    expect(r.safeToRetry).toBe(false);
    expect(r.message).toBe(ACTIVITY_ADVANCED_MESSAGE);
  });

  it("case 12: a nonce that did NOT advance is still not proof nothing was sent", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [endpoint({ label: "rpc0", getTransactionCount: async () => 7n })] },
      attempt,
      hashes: [],
    });
    // The decisive assertion: no matter the nonce, retry is NOT unlocked.
    expect(r.safeToRetry).toBe(false);
  });

  it("case 9: a receipt RPC that is unavailable leaves the outcome UNKNOWN, never a failure", async () => {
    const r = await recoverSubmission({
      reads: {
        account: SENDER,
        endpoints: [
          endpoint({
            label: "rpc0",
            getTransactionReceipt: async () => {
              throw new Error("ETIMEDOUT");
            },
            getTransactionCount: async () => {
              throw new Error("ETIMEDOUT");
            },
          }),
        ],
      },
      attempt,
      hashes: [],
    });
    expect(r.outcome.state).toBe("SUBMISSION_UNKNOWN");
    expect(r.safeToRetry).toBe(false);
  });

  it("case 10: RPC endpoints disagree about pending state → UNKNOWN with activity flagged", async () => {
    const r = await recoverSubmission({
      reads: {
        account: SENDER,
        endpoints: [
          endpoint({ label: "rpc0", getTransactionCount: async () => 7n }),
          endpoint({ label: "rpc1", getTransactionCount: async () => 8n }),
        ],
      },
      attempt,
      hashes: [],
    });
    expect(r.outcome.state).toBe("SUBMISSION_UNKNOWN");
    if (r.outcome.state === "SUBMISSION_UNKNOWN") expect(r.outcome.activityAdvanced).toBe(true);
  });

  it("case 13: genuinely unknown evidence stays UNKNOWN", async () => {
    const r = await recoverSubmission({
      reads: { account: SENDER, endpoints: [] },
      attempt,
      hashes: [],
    });
    expect(r.outcome.state).toBe("SUBMISSION_UNKNOWN");
    expect(r.safeToRetry).toBe(false);
  });
});
