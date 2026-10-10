import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  gasReserveWei,
  quoteGasReserveWei,
  deriveMaxFeePerGasWei,
  FALLBACK_GAS_UNITS,
  FALLBACK_MAX_FEE_PER_GAS_WEI,
} from "@/lib/domain/gasReserve";
import { STEP_GAS_UNITS, stepGasUnits, planGasUnits, buildPaymentPlan } from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";
import { parseUnits } from "@/lib/domain/math";
import { coversBalance, coversGas } from "@/lib/execution/signGuard";
import type { Quote } from "@/lib/domain/intent";

/**
 * Small NATIVE MON transfer regression suite.
 *
 * Reported defect: a ~$0.01 native MON transfer from a wallet holding ~$0.05 of
 * MON (~2 MON at MON ≈ $0.025) was rejected with a generic transaction error,
 * while the same transfer worked directly in the wallet.
 *
 * Root cause (proven): a flat 0.01 MON gas reserve was applied to every native
 * payment in three places. At Monad's ~100 gwei floor a 21,000-gas native
 * transfer costs ~0.0021 MON (Monad docs), so the flat reserve required a
 * balance of amount + 0.01 MON — about 4–5× the real fee — and rejected a
 * transfer whose balance sat between amount + real gas and amount + 0.01 MON.
 * The fix sizes the reserve from the payment's own gasLimit × maxFeePerGas.
 */

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const SENDER = "0x1111111111111111111111111111111111111111" as const;

/** Live Monad values observed during the investigation. */
const LIVE_GAS_PRICE = 102_000_000_000n; // ~102 gwei
const NATIVE_GAS_LIMIT = 21_000n; // Monad native transfer (protocol-defined)

describe("native transfer uses the protocol gas limit, not an inflated estimate", () => {
  it("charges exactly 21,000 gas for a native MON value transfer", () => {
    expect(STEP_GAS_UNITS.transferNative).toBe(21_000n);
  });

  it("keeps ERC-20 transfers and swaps on their own (larger) gas budgets", () => {
    // The native-transfer limit must never leak into token/contract steps.
    expect(STEP_GAS_UNITS.transferToken).toBeGreaterThan(STEP_GAS_UNITS.transferNative);
    expect(STEP_GAS_UNITS.swapBase).toBeGreaterThan(STEP_GAS_UNITS.transferNative);
    expect(STEP_GAS_UNITS.approve).toBeGreaterThan(STEP_GAS_UNITS.transferNative);
  });

  it("a direct native transfer plans a single 21,000-gas transaction", () => {
    const mon = getToken("MON")!;
    const q: Quote = {
      intent: { recipient: RECIPIENT, receiveToken: "MON", receiveAmount: "0.395", amountMode: "recipient_receives" },
      network: "mainnet",
      payToken: mon,
      receiveToken: mon,
      payAmount: "0.395",
      receiveAmount: "0.395",
      payUsd: 0.01,
      receiveUsd: 0.01,
      rate: 1,
      route: { kind: "direct", hops: [], path: ["MON", "MON"] },
      totalSenderCostUsd: 0.01,
      networkCostUsd: 0,
      gasLimit: 21_000n,
      gasPriceWei: LIVE_GAS_PRICE,
      quotedAt: Date.now(),
      exactOutput: false,
    };
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("transfer");
    expect(stepGasUnits(plan.steps[0])).toBe(21_000n);
    expect(planGasUnits(plan)).toBe(21_000n);
  });
});

describe("gas reserve is derived from gasLimit × maxFeePerGas", () => {
  it("sizes the reserve far below the old flat 0.01 MON for a native transfer", () => {
    const reserve = gasReserveWei(NATIVE_GAS_LIMIT, LIVE_GAS_PRICE);
    const oldFlat = 10_000_000_000_000_000n;
    expect(reserve).toBeGreaterThan(0n);
    expect(reserve).toBeLessThan(oldFlat);
    // 21,000 × (102 gwei × 1.2 = 122.4 gwei) = 2.5704e15 wei (~0.00257 MON),
    // under the flat 0.01 MON.
    expect(reserve).toBe(2_570_400_000_000_000n);
  });

  it("buffers a live gas price by 20% and floors it at the Monad base fee", () => {
    expect(deriveMaxFeePerGasWei(LIVE_GAS_PRICE)).toBe((LIVE_GAS_PRICE * 120n) / 100n);
    // A missing/zero price falls back to the base-fee floor + headroom.
    expect(deriveMaxFeePerGasWei(undefined)).toBe(FALLBACK_MAX_FEE_PER_GAS_WEI);
    expect(deriveMaxFeePerGasWei(0n)).toBe(FALLBACK_MAX_FEE_PER_GAS_WEI);
    expect(FALLBACK_MAX_FEE_PER_GAS_WEI).toBeGreaterThanOrEqual(100_000_000_000n);
  });

  it("never returns zero — a native payment always keeps some gas aside", () => {
    expect(gasReserveWei(undefined, undefined)).toBe(
      FALLBACK_GAS_UNITS * FALLBACK_MAX_FEE_PER_GAS_WEI,
    );
    expect(quoteGasReserveWei(null)).toBeGreaterThan(0n);
  });
});

/**
 * The optimizer is the code path that rejects the payment the owner hit. Its
 * `heldEnough` is pure (no RPC); the quote/GasPrice I/O is mocked at the
 * provider + rpc boundary so the REAL eligibility logic runs.
 */
const getGasPrice = vi.fn(async () => LIVE_GAS_PRICE);
vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({ getGasPrice }),
}));

vi.mock("@/lib/providers", () => {
  const make = () => ({
    name: "mock",
    mode: "live",
    supports: () => true,
    priceUsd: vi.fn(async () => ({ usd: 0.0253, source: "mock" })),
    // A native MON → MON direct quote of $0.01, exactly like production.
    quote: vi.fn(async (req: any) => ({
      ok: true,
      route: { kind: "direct", hops: [], path: [req.payToken.symbol, req.receiveToken.symbol] },
      payAmount: req.payToken.symbol === "MON" ? "0.395849473424421561" : req.amount,
      receiveAmount: req.payToken.symbol === "MON" ? "0.395849473424421561" : req.amount,
      rate: 1,
      gasEstimate: req.payToken.symbol === "MON" ? 21_000n : 65_000n,
      exactOutput: false,
      priceImpact: 0,
    })),
    availableSymbols: vi.fn(async () => []),
    reachableSymbols: vi.fn(async () => []),
  });
  const cache = new Map();
  return {
    getRoutingProvider: () => {
      if (!cache.has("m")) cache.set("m", make());
      return cache.get("m");
    },
    UniswapV3Provider: class {},
  };
});

const { optimizePayment } = await import("@/lib/server/optimizer");

beforeEach(() => getGasPrice.mockClear());

const monBalance = (amount: string) => [
  { token: getToken("MON")!, amount, usd: Number(amount) * 0.0253 },
];

function monIntent() {
  return {
    recipient: RECIPIENT,
    receiveToken: "MON",
    receiveAmount: "0.01",
    amountMode: "recipient_receives" as const,
  };
}

describe("optimizer no longer rejects a small native MON payment", () => {
  it("selects a MON source whose balance is only amount + real gas (not +0.01)", async () => {
    // Pay amount 0.395849… + real gas reserve (21,000 × 122.4 gwei ≈ 0.00257 MON)
    // ≈ 0.39842 MON. A balance of 0.399 covers it and must now be eligible; the
    // old flat 0.01 reserve required ≈ 0.40585 and rejected it.
    const result = await optimizePayment(monIntent(), monBalance("0.399") as any);
    expect(result.best?.symbol).toBe("MON");
    expect(result.best?.sufficient).toBe(true);
  });

  it("still rejects a MON source that cannot cover amount + real gas", async () => {
    const result = await optimizePayment(monIntent(), monBalance("0.398") as any);
    expect(result.best).toBeNull();
    const mon = result.options.find((o) => o.symbol === "MON")!;
    expect(mon.sufficient).toBe(false);
  });

  it("accepts the wallet the owner held (~2 MON) with room to spare", async () => {
    const result = await optimizePayment(monIntent(), monBalance("2.0") as any);
    expect(result.best?.sufficient).toBe(true);
  });
});

/**
 * The signing guard's balance check keeps a gas-derived reserve for a native
 * source — the same correction as the optimizer, so review and signing agree.
 */
describe("signing guard reserves real gas for a native MON source", () => {
  const mon = getToken("MON")!;
  function nativeQuote(): Quote {
    return {
      intent: { recipient: RECIPIENT, receiveToken: "MON", receiveAmount: "0.01", amountMode: "recipient_receives" },
      network: "mainnet",
      payToken: mon,
      receiveToken: mon,
      payAmount: "0.395849473424421561",
      receiveAmount: "0.395849473424421561",
      payUsd: 0.01,
      receiveUsd: 0.01,
      rate: 1,
      route: { kind: "direct", hops: [], path: ["MON", "MON"] },
      totalSenderCostUsd: 0.01,
      networkCostUsd: 0,
      gasLimit: 21_000n,
      gasPriceWei: LIVE_GAS_PRICE,
      quotedAt: Date.now(),
      exactOutput: false,
    };
  }
  const balances = (amount: string) => [{ token: mon, amount, usd: Number(amount) * 0.0253 }];

  it("accepts a balance that covers the amount plus real gas (not plus a flat 0.01)", () => {
    // 0.399 covers 0.395849… + ~0.00257 reserve; the flat reserve would need 0.40585.
    expect(coversBalance(balances("0.399") as any, nativeQuote())).toBe(true);
  });

  it("blocks a balance that cannot cover the amount plus real gas", () => {
    expect(coversBalance(balances("0.398") as any, nativeQuote())).toBe(false);
  });

  it("an ERC-20 source is unaffected — no native reserve is applied", () => {
    const usdc = getToken("USDC")!;
    const q: Quote = {
      ...nativeQuote(),
      payToken: usdc,
      receiveToken: usdc,
      payAmount: "5",
      receiveAmount: "5",
      route: { kind: "direct", hops: [], path: ["USDC", "USDC"] },
    };
    expect(coversBalance([{ token: usdc, amount: "5", usd: 5 }] as any, q)).toBe(true);
    expect(coversBalance([{ token: usdc, amount: "4.99", usd: 4.99 }] as any, q)).toBe(false);
  });

  it("coversGas still blocks a wallet whose MON cannot cover the fee", () => {
    // The gas fee (21,000 × 102 gwei ≈ 0.00214 MON) exceeds a 0.001 MON balance.
    expect(coversGas(balances("0.001") as any, 21_000n, LIVE_GAS_PRICE)).toBe(false);
    expect(coversGas(balances("2") as any, 21_000n, LIVE_GAS_PRICE)).toBe(true);
  });
});

/**
 * Genuine prerequisites that must keep blocking (not "arbitrary minimums").
 */
describe("genuine small-payment constraints remain intact", () => {
  it("a $0.01 worth of MON resolves to a real, positive base-unit amount (18-dp)", () => {
    const mon = parseUnits("0.395849473424421561", 18);
    expect(mon).toBeGreaterThan(0n);
    expect(mon).toBe(395849473424421561n);
  });

  it("an amount that rounds to zero base units is still rejected clearly", async () => {
    const { validateAmount } = await import("@/lib/domain/validation");
    const issue = validateAmount("0.0000000000000000001", 18);
    expect(issue?.code).toBe("invalid_amount");
  });
});

/**
 * Token liquidity is a genuine, evidence-backed prerequisite (not a hidden
 * transfer minimum), and it is reported with its measured value.
 */
describe("thin-liquidity tokens are reported, not silently blocked by a cap", () => {
  it("classifies a sub-threshold pool as INSUFFICIENT_LIQUIDITY with the measured value", async () => {
    const { assessTokenRisk, MIN_EXECUTABLE_LIQUIDITY_USD } = await import("@/lib/domain/tokenRisk");
    const report = assessTokenRisk({
      decimals: 18,
      liquidityUsd: MIN_EXECUTABLE_LIQUIDITY_USD - 1,
      priceImpact: null,
      maxPriceImpact: 0.03,
      transferSim: { ok: true },
      hasRoute: true,
    });
    expect(report.blocked).toBe(true);
    expect(report.state).toBe("INSUFFICIENT_LIQUIDITY");
    expect(report.reason).toMatch(/liquidity/i);
  });

  it("does not block a liquid token", async () => {
    const { assessTokenRisk } = await import("@/lib/domain/tokenRisk");
    const report = assessTokenRisk({
      decimals: 18,
      liquidityUsd: 1_000_000,
      priceImpact: 0.001,
      maxPriceImpact: 0.03,
      transferSim: { ok: true },
      hasRoute: true,
    });
    expect(report.blocked).toBe(false);
    expect(report.safe).toBe(true);
  });
});

