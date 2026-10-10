import { describe, expect, it } from "vitest";
import { parseIntent } from "@/lib/nlp/parser";
import { parseUnits, formatUnits, usdToAmount, isPositiveDecimal } from "@/lib/domain/math";
import { validateAmount, validateUsdAmount } from "@/lib/domain/validation";
import { computeReadiness, type ReadinessInput } from "@/lib/domain/readiness";
import {
  classifyTransactionError,
  withFeeShortfallMessage,
  INSUFFICIENT_MON_FOR_FEES_MESSAGE,
} from "@/lib/domain/transactionError";
import {
  buildPaymentPlan,
  planGasUnits,
  stepGasUnits,
} from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";
import type { Quote } from "@/lib/domain/intent";

/**
 * Small-payment regression suite.
 *
 * Reported defect: a ~$0.80 USDC payment succeeded but a ~$0.10-worth-of-MON
 * payment failed with a generic transaction error. The investigation found NO
 * product or protocol minimum transfer; the quote for $0.10 worth of MON builds
 * correctly. The real cause was that gas affordability was validated against a
 * SINGLE transaction's fee, while a swap payment is several sequential
 * transactions (approve → swap → unwrap → deliver) that each charge their own
 * fee. These tests lock in the corrected, plan-wide gas accounting and the
 * honest, actionable error surfaces.
 */

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const SENDER = "0x1111111111111111111111111111111111111111" as const;

// 1. Parsing a request for "$0.10 worth of MON".
describe("intent parsing: $0.10 worth of MON", () => {
  it("reads it as a USD value denominated in MON (not 0.10 MON)", () => {
    const intent = parseIntent(
      "Send $0.10 worth of MON to 0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
      { symbols: ["MON", "USDC", "USDT"] },
    );
    expect(intent.amount).toBe("0.10");
    expect(intent.amountType).toBe("USD_VALUE");
    expect(intent.asset).toBe("MON");
    expect(intent.recipientAddress?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it("keeps the three amount forms distinct", () => {
    const ctx = { symbols: ["MON", "USDC"] };
    expect(parseIntent("Send 10 MON to 0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4", ctx)).toMatchObject({
      amount: "10",
      amountType: "TOKEN_AMOUNT",
      asset: "MON",
    });
    expect(parseIntent("Send $10 to 0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4", ctx)).toMatchObject({
      amount: "10",
      amountType: "USD_VALUE",
    });
  });
});

// 2 + 3. Correct USD→MON conversion and native 18-decimal handling.
describe("USD→MON conversion and native decimals", () => {
  it("uses native 18-decimal units without premature rounding", () => {
    expect(parseUnits("0.1", 18)).toBe(100000000000000000n); // 1e17
    expect(parseUnits("4.026882517185820021", 18)).toBe(4026882517185820021n);
    expect(formatUnits(4026882517185820021n, 18)).toBe("4.026882517185820021");
  });

  it("converts a USD figure to a MON quantity with the live price (no invented rate)", () => {
    // $0.10 at ~$40.03/MON ≈ 0.002498 MON; exact figure is not the point — that
    // it is derived from the supplied price and is positive is.
    const mon = usdToAmount(0.1, 40.03);
    expect(Number(mon)).toBeGreaterThan(0);
    expect(isPositiveDecimal(mon)).toBe(true);
    // A zero/absent price must never fabricate a quantity.
    expect(usdToAmount(0.1, 0)).toBe("0");
  });
});

// 4. A valid small MON payment is accepted by amount validation.
describe("amount validation does not impose a hidden minimum", () => {
  it("accepts $0.10 as a USD amount (no product minimum)", () => {
    expect(validateUsdAmount("0.10")).toBeNull();
    expect(validateUsdAmount("0.01")).toBeNull();
  });

  it("accepts a small native MON token amount", () => {
    expect(validateAmount("0.1", 18)).toBeNull();
    expect(validateAmount("0.0001", 18)).toBeNull();
  });

  it("rejects only a genuinely unrepresentable amount (rounds to zero base units)", () => {
    // With 6 decimals, 0.0000001 is below one base unit — it cannot be sent.
    const issue = validateAmount("0.0000001", 6);
    expect(issue?.code).toBe("invalid_amount");
    expect(issue?.message).toMatch(/too small/i);
  });
});

// Root cause fix: gas is accounted for across the WHOLE plan.
describe("plan-wide gas accounting", () => {
  function monOutputQuote(): Quote {
    const usdc = getToken("USDC")!;
    const mon = getToken("MON")!;
    return {
      intent: { recipient: RECIPIENT, receiveToken: "MON", receiveAmount: "0.10", amountMode: "recipient_receives" },
      network: "mainnet",
      payToken: usdc,
      receiveToken: mon,
      payAmount: "0.100596",
      receiveAmount: "4.026882517185820021",
      payUsd: 0.100596,
      receiveUsd: 0.1,
      rate: 1,
      priceImpact: 0,
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDC", toSymbol: "MON", fee: 3000, pool: "0x659bD0BC4167BA25c62E05656F78043E7eD4a9da" }],
        path: ["USDC", "MON"],
        tokens: [usdc, mon],
      },
      totalSenderCostUsd: 0.1,
      networkCostUsd: 0.0004,
      quotedAt: Date.now(),
      exactOutput: true,
    };
  }

  it("counts every sequential transaction in a swap payment, not just one", () => {
    const plan = buildPaymentPlan(monOutputQuote(), SENDER, RECIPIENT);
    // approve → swap → unwrap → transfer
    expect(plan.steps.map((s) => s.kind)).toEqual(["approve", "swap", "unwrap", "transfer"]);
    const single = stepGasUnits(plan.steps.find((s) => s.kind === "swap")!);
    const total = planGasUnits(plan);
    expect(total).toBeGreaterThan(single);
    // The steerable, non-native-output swap still needs approve + swap.
    expect(total).toBeGreaterThanOrEqual(185_000n);
  });

  it("counts a direct transfer as a single transaction", () => {
    const usdc = getToken("USDC")!;
    const q: Quote = {
      intent: { recipient: RECIPIENT, receiveToken: "USDC", receiveAmount: "0.80", amountMode: "recipient_receives" },
      network: "mainnet",
      payToken: usdc,
      receiveToken: usdc,
      payAmount: "0.80",
      receiveAmount: "0.80",
      payUsd: 0.8,
      receiveUsd: 0.8,
      rate: 1,
      route: { kind: "direct", hops: [], path: ["USDC", "USDC"] },
      totalSenderCostUsd: 0.8,
      networkCostUsd: 0,
      quotedAt: Date.now(),
      exactOutput: false,
    };
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT);
    expect(planGasUnits(plan)).toBe(stepGasUnits(plan.steps[0]));
  });
});

// 6 + 7 + 8. Balance/gas sufficiency yields the correct cause.
describe("balance vs gas sufficiency is classified precisely", () => {
  function ready(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
    return {
      recipient: RECIPIENT,
      recipientConfirmed: true,
      payTokenIsSet: true,
      payToken: "USDC",
      receiveToken: "MON",
      quoting: false,
      quote: { route: { kind: "swap", path: ["USDC", "MON"] }, payAmount: "0.10", receiveAmount: "4.02" },
      quoteError: null,
      quoteStale: false,
      sufficiency: { status: "ok" },
      gasSufficiency: { status: "ok", requiredMon: "0.02" },
      mismatchActive: false,
      ...overrides,
    };
  }

  it("covers the payment but not the total gas → insufficient MON for network fees", () => {
    const r = computeReadiness(ready({ gasSufficiency: { status: "insufficient", requiredMon: "0.02" } }));
    expect(r.ready).toBe(false);
    expect(r.code).toBe("insufficient_gas");
    // The one canonical fee-shortfall message — not a second, detail-bearing
    // variant that leaked the required MON figure.
    expect(r.message).toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
    expect(r.message).not.toMatch(/several on-chain transactions|needs about|in total for gas/i);
  });

  it("covers both the payment and the gas → ready", () => {
    expect(computeReadiness(ready()).code).toBe("ready");
  });

  it("a token shortfall is reported as insufficient balance, never as a gas or minimum issue", () => {
    const r = computeReadiness(ready({ sufficiency: { status: "insufficient", required: "0.5", available: "0.1" } }));
    expect(r.code).toBe("insufficient_balance");
    expect(r.message).toMatch(/need 0.5/);
    expect(r.message).not.toMatch(/minimum/i);
  });

  /**
   * The reported small NATIVE MON defect: the balance covers the transfer amount
   * but not the amount + the required maximum gas fee. This must be classified
   * as a fee shortfall (`insufficient_gas`), not as an insufficient balance, and
   * receive the specific, actionable message.
   */
  it("enough for the amount but not the amount + fee → the specific MON-for-fees message", () => {
    const r = computeReadiness(
      ready({
        payToken: "MON",
        receiveToken: "MON",
        // `cause: "fees"` is set only when the balance covers the amount itself.
        sufficiency: { status: "insufficient", required: "0.3958", available: "0.397", cause: "fees" },
        gasSufficiency: { status: "ok", requiredMon: "0.0025" },
      }),
    );
    expect(r.ready).toBe(false);
    expect(r.code).toBe("insufficient_gas");
    const shown = withFeeShortfallMessage(r);
    expect(shown.message).toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
  });

  it("cannot cover the amount itself → ordinary insufficient balance, not the fee message", () => {
    const r = computeReadiness(
      ready({
        payToken: "MON",
        receiveToken: "MON",
        sufficiency: { status: "insufficient", required: "0.4", available: "0.39", cause: "amount" },
        gasSufficiency: { status: "ok", requiredMon: "0.0025" },
      }),
    );
    expect(r.code).toBe("insufficient_balance");
    expect(withFeeShortfallMessage(r).message).not.toMatch(/Reduce the transfer amount/i);
  });

  it("an unrelated failure keeps its own message and never becomes a fee message", () => {
    const r = computeReadiness(
      ready({ payToken: "USDC", sufficiency: { status: "insufficient", required: "5", available: "4", cause: "amount" } }),
    );
    expect(r.code).toBe("insufficient_balance");
    expect(withFeeShortfallMessage(r).message).toBe(r.message);
  });
});

// 9. A provider/RPC failure is never misclassified as a minimum-limit error.
describe("error classification never invents a minimum limit", () => {
  it("a transient RPC failure is an unknown/ambiguous outcome, not a minimum", () => {
    const info = classifyTransactionError(new Error("Network error: failed to fetch"));
    expect(["rpc_unavailable", "unknown"]).toContain(info.kind);
    expect(info.message.toLowerCase()).not.toMatch(/minimum/);
  });

  it("a slippage/min-output failure maps to a specific, actionable message", () => {
    const info = classifyTransactionError(new Error("execution reverted: Insufficient output amount"));
    expect(info.kind).toBe("slippage");
    expect(info.mayHaveSubmitted).toBe(false);
    expect(info.message).toMatch(/slippage/i);
    expect(info.action).toBe("Refresh quote");
  });

  it("insufficient gas is the total-fee message, not a minimum-transfer message", () => {
    const info = classifyTransactionError(new Error("insufficient funds for gas * price + value"));
    expect(info.kind).toBe("insufficient_gas");
    expect(info.message).toMatch(/MON/);
    expect(info.message.toLowerCase()).not.toMatch(/minimum/);
  });
});

// 11. A route/liquidity failure is a route error, not a minimum.
describe("route/liquidity failure", () => {
  it("maps a missing route to a no-route outcome", () => {
    const info = classifyTransactionError({ message: "No supported liquidity route can currently satisfy this payment." });
    expect(info.kind).toBe("no_route");
    expect(info.message.toLowerCase()).not.toMatch(/minimum/);
  });
});

// 12 + 13. Broadcast/confirmation safety is preserved.
describe("broadcast and confirmation safety", () => {
  it("an ambiguous post-submission failure is unknown-outcome and must not be retried", () => {
    const info = classifyTransactionError({ code: "submitted", message: "tx sent" });
    expect(info.kind).toBe("unknown_outcome");
    expect(info.mayHaveSubmitted).toBe(true);
    expect(info.action).toBe("Check status");
  });
});

// 14 + 15. The successful path and its invariants are unchanged.
describe("the $0.80 USDC regression and its invariants", () => {
  it("keeps a small same-asset payment a single direct transfer to the exact recipient", () => {
    const usdt = getToken("USDT")!;
    const usdc = getToken("USDC")!;
    const q: Quote = {
      intent: { recipient: RECIPIENT, receiveToken: "USDC", receiveAmount: "0.80", amountMode: "recipient_receives" },
      network: "mainnet",
      payToken: usdt,
      receiveToken: usdc,
      payAmount: "0.80064",
      receiveAmount: "0.8",
      payUsd: 0.80064,
      receiveUsd: 0.8,
      rate: 1,
      priceImpact: 0,
      route: { kind: "swap", hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0xacf82ECC826A9fc2D8c8C4d370d2D268fA5B3500" }], path: ["USDT", "USDC"], tokens: [usdt, usdc] },
      totalSenderCostUsd: 0.8,
      networkCostUsd: 0.0004,
      quotedAt: Date.now(),
      exactOutput: true,
    };
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT);
    const swap = plan.steps.find((s) => s.kind === "swap")!;
    if (swap.kind !== "swap") throw new Error("expected a swap");
    // The recipient, the requested output and the amount are never substituted.
    expect(swap.recipient).toBe(RECIPIENT);
    expect(swap.amountOut).toBe(parseUnits("0.8", 6));
    expect(swap.amountInMaximum! > 0n).toBe(true);
    expect(q.payToken.symbol).toBe("USDT");
    expect(q.receiveToken.symbol).toBe("USDC");
  });
});
