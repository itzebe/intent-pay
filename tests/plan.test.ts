import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { buildPaymentPlan, describePlan, planEconomics } from "@/lib/execution/plan";
import { planHasOutputBound } from "@/lib/execution/signGuard";
import { encodeStep } from "@/lib/execution/execute";
import { SWAP_ROUTER_ABI } from "@/lib/execution/abis";
import { getToken } from "@/lib/config/tokens";
import { parseUnits } from "@/lib/domain/math";
import type { Quote } from "@/lib/domain/intent";

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;

function quote(overrides: Partial<Quote>): Quote {
  const payToken = getToken("USDT")!;
  const receiveToken = getToken("USDC")!;
  return {
    intent: { recipient: RECIPIENT, receiveToken: "USDC", receiveAmount: "5", amountMode: "recipient_receives" },
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
    // A swap with no pool/hop data carries nothing to construct a real
    // transaction from; it must not be presented as a direct transfer, and must
    // never reach on-chain execution.
    const plan = buildPaymentPlan(quote({}), SENDER, RECIPIENT);
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

describe("on-chain output protection", () => {
  it("carries a real amountOutMinimum on an exact-input swap", () => {
    const q = quote({
      exactOutput: false,
      receiveAmount: "5",
      payAmount: "5.01",
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 100);
    const swap = plan.steps.find((s) => s.kind === "swap")!;
    expect(swap.kind === "swap" && swap.amountOutMinimum).toBe(parseUnits("4.95", 6));
    expect(plan.slippageBps).toBe(100);
    expect(planHasOutputBound(plan)).toBe(true);
  });

  it("carries a real amountInMaximum on an exact-output swap", () => {
    const q = quote({
      exactOutput: true,
      receiveAmount: "5",
      payAmount: "5.01",
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 50);
    const swap = plan.steps.find((s) => s.kind === "swap")!;
    expect(swap.kind === "swap" && swap.amountInMaximum).toBeGreaterThan(parseUnits("5.01", 6));
    expect(planHasOutputBound(plan)).toBe(true);
  });

  it("clamps slippage even when the caller asks for a very wide tolerance", () => {
    const q = quote({
      exactOutput: false,
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 9_999);
    expect(plan.slippageBps).toBe(500);
  });

  it("flags a bound-less swap as unprotected", () => {
    const q = quote({ route: { kind: "swap", hops: [], path: ["USDT", "USDC"] } });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT);
    // A hop-less swap is not executable, but the bound check must still refuse
    // to call it protected.
    expect(plan.executable).toBe(false);
    expect(planHasOutputBound(plan)).toBe(false);
  });

  it("planEconomics reflects the tolerance actually encoded", () => {
    const q = quote({
      exactOutput: false,
      receiveAmount: "5",
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const econ = planEconomics(q, 100);
    expect(econ.slippageBps).toBe(100);
    expect(econ.minimumReceived).toBe("4.95");
    expect(econ.exact).toBe(false);
  });

  it("encodes the amountOutMinimum into the real router calldata", () => {
    const q = quote({
      exactOutput: false,
      receiveAmount: "5",
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 100);
    const swap = plan.steps.find((s) => s.kind === "swap")!;
    const call = encodeStep(swap);
    const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: call.data! });
    expect(decoded.functionName).toBe("exactInputSingle");
    const params = (decoded.args as any)[0];
    // The protection lives in the calldata the router enforces on-chain.
    expect(params.amountOutMinimum).toBe(parseUnits("4.95", 6));
    expect(params.amountOutMinimum).toBeGreaterThan(0n);
  });

  it("encodes the amountInMaximum into the real router calldata for exact-output", () => {
    const q = quote({
      exactOutput: true,
      receiveAmount: "5",
      payAmount: "5.01",
      route: {
        kind: "swap",
        hops: [{ fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
        path: ["USDT", "USDC"],
        tokens: [getToken("USDT")!, getToken("USDC")!],
      },
    });
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 50);
    const swap = plan.steps.find((s) => s.kind === "swap")!;
    const call = encodeStep(swap);
    const decoded = decodeFunctionData({ abi: SWAP_ROUTER_ABI, data: call.data! });
    expect(decoded.functionName).toBe("exactOutputSingle");
    const params = (decoded.args as any)[0];
    expect(params.amountOut).toBe(parseUnits("5", 6));
    expect(params.amountInMaximum).toBe(parseUnits("5.01", 6) + (parseUnits("5.01", 6) * 50n) / 10_000n);
  });
});
