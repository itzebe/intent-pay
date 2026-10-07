import { describe, expect, it } from "vitest";
import { buildPaymentPlan, describePlan } from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";
import type { Quote } from "@/lib/domain/intent";

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;

function quote(overrides: Partial<Quote>): Quote {
  const payToken = getToken("USDT")!;
  const receiveToken = getToken("USDC")!;
  return {
    intent: { recipient: RECIPIENT, receiveToken: "USDC", receiveAmount: "5", amountMode: "recipient_receives" },
    mode: "live",
    network: "mainnet",
    payToken,
    receiveToken,
    payAmount: "5.01",
    receiveAmount: "5",
    payUsd: 5.01,
    receiveUsd: 5,
    rate: 1,
    route: { kind: "swap", hops: [], path: ["USDT", "USDC"] },
    totalSenderCostUsd: 5.02,
    networkCostUsd: 0.01,
    quotedAt: Date.now(),
    exactOutput: true,
    ...overrides,
  };
}

describe("buildPaymentPlan", () => {
  it("describes a same-asset payment as a direct transfer", () => {
    const q = quote({
      route: { kind: "direct", hops: [], path: ["USDC", "USDC"] },
      payToken: getToken("USDC")!,
      receiveToken: getToken("USDC")!,
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT);
    expect(plan.executable).toBe(true);
    expect(describePlan(plan)).toEqual(["Send USDC to recipient"]);
  });

  it("describes a hop-less swap as a conversion and never marks it executable", () => {
    // Demo / simulated swaps carry no pool data; they must not be presented as
    // a direct transfer, and must never reach on-chain execution.
    const plan = buildPaymentPlan(quote({ mode: "demo" }), SENDER, RECIPIENT);
    expect(plan.executable).toBe(false);
    expect(describePlan(plan)).toEqual(["Convert USDT → USDC"]);
  });

  it("builds approve + swap steps for a real live route", () => {
    const q = quote({
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT);
    expect(plan.executable).toBe(true);
    expect(describePlan(plan)).toEqual([
      "Approve up to 5.01 USDT for the route",
      "Convert USDT → USDC",
    ]);
  });
});
