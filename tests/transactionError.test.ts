import { describe, expect, it } from "vitest";
import { classifyTransactionError } from "@/lib/domain/transactionError";

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

  it("maps insufficient gas to an actionable MON message", () => {
    const info = classifyTransactionError(
      new Error("insufficient funds for gas * price + value"),
    );
    expect(info.kind).toBe("insufficient_gas");
    expect(info.mayHaveSubmitted).toBe(false);
    expect(info.message).toMatch(/MON/);
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
