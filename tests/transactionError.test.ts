import { describe, expect, it } from "vitest";
import {
  classifyTransactionError,
  withFeeShortfallMessage,
  isFeeShortfall,
  isTransportError,
  isWalletTransportFailure,
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

  /**
   * Mission 24/25. Trust Wallet's in-app browser opens its native approval, the
   * user enters their password, and only then does its native layer fail with
   * `Failed to connect to http://monad.twnodes.com/`. That must be recognised as
   * a *transport* failure of the wallet's own provider, not our RPC being down,
   * and classified as an unknown outcome (never a definite "not sent").
   */
  it("recognises the Trust Wallet post-password transport failure", () => {
    const raw = new TypeError("Failed to connect to http://monad.twnodes.com/");
    expect(isTransportError(raw)).toBe(true);
    const info = classifyTransactionError(raw, { source: "wallet" });
    expect(info.kind).toBe("wallet_rpc");
    expect(info.mayHaveSubmitted).toBe(true);
    // The raw host never reaches the user.
    expect(info.message).not.toContain("twnodes");
  });

  it("recognises a connection-refused/DNS failure as transport", () => {
    for (const message of [
      "Failed to fetch",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_NAME_NOT_RESOLVED",
      "connect ECONNREFUSED 127.0.0.1:8545",
      "getaddrinfo ENOTFOUND monad.twnodes.com",
      "connect ETIMEDOUT",
      "socket hang up",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(isTransportError(new TypeError(message)), message).toBe(true);
    }
  });

  it("does not mistake a rejection or an on-chain revert for a transport failure", () => {
    expect(isTransportError(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe(false);
    expect(isTransportError(new Error("execution reverted: insufficient output amount"))).toBe(false);
    expect(classifyTransactionError(Object.assign(new Error("User rejected the request."), { code: 4001 })).kind).toBe("rejected");
  });

  /**
   * The wallet-side detection is separate from our own RPC being down: it only
   * fires for a *step-tagged* submission failure, so a quote/balance/receipt
   * read that fails is never blamed on the wallet.
   */
  it("only calls it a wallet transport failure when the failure came from a submission step", () => {
    const walletErr = Object.assign(new Error("The transaction could not be sent."), {
      code: "unknown",
      stepId: "transfer",
      cause: new TypeError("Failed to connect to http://monad.twnodes.com/"),
    });
    expect(isWalletTransportFailure(walletErr)).toBe(true);
    expect(isWalletTransportFailure(new TypeError("Failed to connect to http://monad.twnodes.com/"))).toBe(false);
    const info = classifyTransactionError(walletErr, { source: "wallet" });
    expect(info.kind).toBe("wallet_rpc");
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

  /**
   * Mission 25. A submission failure the classifier cannot pin to a cause — the
   * bare "Transaction error" Trust Wallet's native layer can raise after the user
   * authorises — must NOT be reported as a definite pre-submission failure with a
   * plain Retry. The failing step id proves the wallet was asked to send, so the
   * outcome is unknown: the transaction may be on-chain.
   */
  it("treats a step-tagged unrecognised submission failure as an unknown outcome", () => {
    const stepTagged = Object.assign(new Error("The transaction could not be sent."), {
      code: "unknown",
      stepId: "transfer",
      cause: new Error("Transaction error"),
    });
    const info = classifyTransactionError(stepTagged);
    expect(info.kind).toBe("unknown_outcome");
    expect(info.mayHaveSubmitted).toBe(true);
    expect(info.action).toBe("Check status");
    expect(info.message).not.toMatch(/Transaction error/);
  });

  it("keeps a step-less unrecognised failure as a definite generic failure", () => {
    // A failure that never reached a submission step (no step id) is an
    // application error, not an ambiguous broadcast: it keeps the generic
    // fallback and does not claim the transaction may be on-chain.
    const info = classifyTransactionError(new Error("some totally unexpected internal error"));
    expect(info.kind).toBe("unknown");
    expect(info.mayHaveSubmitted).toBe(false);
  });

  it("treats an explicit 'method unsupported' as a definite pre-submission failure", () => {
    // EIP-1193 4200 / -32601 mean the wallet cannot submit at all: nothing was
    // broadcast, so this keeps a usable retry — it must not be lumped into the
    // ambiguous unknown-outcome case.
    for (const code of [4200, -32601]) {
      const stepTagged = Object.assign(new Error("The transaction could not be sent."), {
        code: "unknown",
        stepId: "transfer",
        cause: Object.assign(new Error("Unsupported method"), { code }),
      });
      const info = classifyTransactionError(stepTagged);
      expect(info.kind).toBe("unsupported");
      expect(info.mayHaveSubmitted).toBe(false);
    }
  });

  // Regression: the execution layer wraps the wallet/RPC failure in its own
  // ExecutionError. The real cause lives on `.cause` (and, for viem, on a nested
  // cause chain). The classifier must read through it, otherwise a specific
  // cause is lost and the user only sees the generic fallback — the "returns to
  // Confirm and Send with no explanation" report.
  it("reads the real cause through a wrapper with a preserved `cause`", () => {
    const wrapper = Object.assign(new Error("The transaction could not be sent."), {
      code: "unknown",
      cause: Object.assign(new Error("insufficient funds for gas * price + value"), { code: -32000 }),
    });
    const info = classifyTransactionError(wrapper);
    expect(info.kind).toBe("insufficient_gas");
    expect(info.message).toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
  });

  it("reads a nested viem-style cause chain", () => {
    const providerError = Object.assign(new Error("execution reverted: STF"), {
      code: 3,
      data: "0x08c379a0",
    });
    const viemError = Object.assign(new Error("The contract function ... reverted."), {
      shortMessage: "execution reverted: STF",
      cause: providerError,
    });
    const wrapper = Object.assign(new Error("The transaction could not be sent."), {
      cause: viemError,
    });
    const info = classifyTransactionError(wrapper);
    // STF (Safe Transfer Failed) is a token/allowance failure, not the generic
    // fallback; either way it must NOT be the unknown fallback.
    expect(info.kind).not.toBe("unknown");
  });

  it("prefers the gas-shortfall reading of an 'insufficient funds' fee error", () => {
    const info = classifyTransactionError(
      new Error("insufficient funds for gas * price + value: address 0x… have 0 want 1"),
    );
    expect(info.kind).toBe("insufficient_gas");
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
 * `isFeeShortfall` is the single condition that lets the fee-shortfall copy be
 * shown. It must fire for a genuine native-MON fee shortfall and nothing else.
 */
describe("isFeeShortfall", () => {
  it("fires when the balance covers the amount but not the amount + fee", () => {
    expect(
      isFeeShortfall({
        sufficiency: { status: "insufficient", cause: "fees" },
        gasSufficiency: { status: "ok" },
      }),
    ).toBe(true);
  });

  it("fires when the plan's total gas exceeds the wallet's MON", () => {
    expect(
      isFeeShortfall({
        sufficiency: { status: "ok" },
        gasSufficiency: { status: "insufficient" },
      }),
    ).toBe(true);
  });

  it("does NOT fire for an ordinary transfer-balance shortfall", () => {
    expect(
      isFeeShortfall({
        sufficiency: { status: "insufficient", cause: "amount" },
        gasSufficiency: { status: "ok" },
      }),
    ).toBe(false);
    // A shortfall with no cause is treated as an amount shortfall, not a fee one.
    expect(
      isFeeShortfall({
        sufficiency: { status: "insufficient" },
        gasSufficiency: { status: "ok" },
      }),
    ).toBe(false);
  });

  it("does not fire for a healthy payment or an unknown state", () => {
    expect(
      isFeeShortfall({ sufficiency: { status: "ok" }, gasSufficiency: { status: "ok" } }),
    ).toBe(false);
    expect(
      isFeeShortfall({ sufficiency: { status: "unknown" }, gasSufficiency: { status: "unknown" } }),
    ).toBe(false);
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
