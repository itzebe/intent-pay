import { describe, expect, it } from "vitest";
import {
  classifyTransactionError,
  withFeeShortfallMessage,
  INSUFFICIENT_MON_FOR_FEES_MESSAGE,
} from "@/lib/domain/transactionError";

/**
 * The mapping must never let a raw provider/RPC string reach the user, and must
 * never invent an outcome: an ambiguous post-submission failure is reported as
 * unknown (may have submitted), never as a definite failure or success.
 */
describe("classifyTransactionError", () => {
  it("maps a user rejection (code 4001) to a cancelled, not-submitted outcome", () => {
    const info = classifyTransactionError({ code: 4001, message: "User rejected the request." });
    expect(info.kind).toBe("rejected");
    expect(info.mayHaveSubmitted).toBe(false);
    expect(info.message).toMatch(/cancelled/i);
  });

  it("maps the execution layer's `rejected` code", () => {
    const info = classifyTransactionError({ code: "rejected", message: "You rejected the transaction." });
    expect(info.kind).toBe("rejected");
    expect(info.mayHaveSubmitted).toBe(false);
  });

  it("maps insufficient gas to the specific, actionable MON-for-fees message", () => {
    const info = classifyTransactionError(
      new Error("insufficient funds for gas * price + value"),
    );
    expect(info.kind).toBe("insufficient_gas");
    expect(info.mayHaveSubmitted).toBe(false);
    expect(info.message).toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
    expect(info.message).toMatch(/Insufficient MON for network fees/i);
    expect(info.message).toMatch(/also need enough MON to cover the transaction fee/i);
    expect(info.message).toMatch(/Reduce the transfer amount or add MON to your wallet/i);
  });

  it("maps insufficient token funds", () => {
    const info = classifyTransactionError(new Error("transfer amount exceeds balance"));
    expect(info.kind).toBe("insufficient_funds");
    expect(info.mayHaveSubmitted).toBe(false);
  });

  it("maps a reverted receipt to a reverted outcome", () => {
    const info = classifyTransactionError({ code: "reverted", message: "The transaction reverted on Monad." });
    expect(info.kind).toBe("reverted");
    expect(info.mayHaveSubmitted).toBe(false);
  });

  it("maps an expired quote to a refresh action", () => {
    const info = classifyTransactionError(new Error("This quote is stale."));
    expect(info.kind).toBe("expired_quote");
    expect(info.action).toBe("Refresh quote");
  });

  it("maps an unavailable route to a no-route outcome", () => {
    const info = classifyTransactionError({ code: "route_unavailable", message: "No route" });
    expect(info.kind).toBe("no_route");
  });

  it("treats an ambiguous post-submission failure as unknown — may have submitted", () => {
    const info = classifyTransactionError({ code: "submitted", message: "The payment did not confirm on Monad." });
    expect(info.kind).toBe("unknown_outcome");
    expect(info.mayHaveSubmitted).toBe(true);
    expect(info.message).toMatch(/could not confirm|may still/i);
  });

  it("treats a network/RPC failure as unknown — may have submitted", () => {
    const info = classifyTransactionError(new Error("fetch failed"));
    expect(info.kind).toBe("rpc_unavailable");
    expect(info.mayHaveSubmitted).toBe(true);
  });

  it("never surfaces the raw provider string to the user", () => {
    const raw = "Error: -32000 header not found (code=-32000, version=2.2.0)";
    const info = classifyTransactionError(new Error(raw));
    expect(info.message).not.toContain("-32000");
    expect(info.message).not.toContain("version=");
  });

  it("falls back to a generic, non-technical message for anything else", () => {
    const info = classifyTransactionError(new Error("some totally unexpected internal error"));
    expect(info.kind).toBe("unknown");
    expect(info.mayHaveSubmitted).toBe(false);
    expect(info.message).not.toMatch(/internal|stack|unexpected/i);
  });
});

/**
 * The specific fee-shortfall copy is only used when the validation result really
 * is "enough MON for the amount, not enough for the amount + fee". Every other
 * code keeps its own message.
 */
describe("withFeeShortfallMessage", () => {
  it("replaces the message only for an insufficient_gas result", () => {
    const r = withFeeShortfallMessage({ ready: false, code: "insufficient_gas", message: "old" });
    expect(r.code).toBe("insufficient_gas");
    expect(r.ready).toBe(false);
    expect(r.message).toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
  });

  it("leaves unrelated failure codes untouched", () => {
    for (const code of [
      "insufficient_balance",
      "invalid_recipient",
      "no_route",
      "unsupported_token",
      "quote_stale",
      "quote_unavailable",
      "amount_mismatch",
      "incomplete_amount",
    ]) {
      const original = { ready: false, code, message: "original message" };
      expect(withFeeShortfallMessage(original)).toEqual(original);
    }
  });

  it("leaves a ready payment untouched", () => {
    const original = { ready: true, code: "ready", message: undefined };
    expect(withFeeShortfallMessage(original)).toEqual(original);
  });
});

/**
 * The specific message must never be produced for an unrelated failure. This is
 * the "do not show it for wallet rejection / RPC timeout / unsupported asset /
 * invalid recipient / reverted tx" guarantee.
 */
describe("the fee message is never shown for unrelated failures", () => {
  const cases: Array<[string, unknown]> = [
    ["wallet rejection", { code: 4001, message: "User rejected the request." }],
    ["rejected execution code", { code: "rejected", message: "denied transaction" }],
    ["RPC timeout", new Error("fetch failed: timeout")],
    ["unsupported asset", { code: "unsupported_token", message: "unsupported token" }],
    ["no route", { code: "route_unavailable", message: "No route" }],
    ["expired quote", new Error("quote is stale")],
    ["reverted transaction", { code: "reverted", message: "execution reverted" }],
    ["unknown outcome", { code: "submitted", message: "did not confirm" }],
    ["invalid recipient", { code: "invalid_recipient", message: "bad address" }],
    ["unexpected internal error", new Error("some unexpected internal error")],
  ];

  for (const [label, err] of cases) {
    it(`does not show the fee message for ${label}`, () => {
      const info = classifyTransactionError(err);
      expect(info.kind).not.toBe("insufficient_gas");
      expect(info.message).not.toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
      expect(info.message).not.toMatch(/Reduce the transfer amount/i);
    });
  }
});
