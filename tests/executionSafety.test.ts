import { describe, expect, it } from "vitest";
import { decodeEventLog, toFunctionSelector, type PublicClient } from "viem";
import {
  prepareSigning,
  planHasOutputBound,
  type SigningFetchers,
} from "@/lib/execution/signGuard";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { encodeStep, FINALITY_CONFIRMATIONS } from "@/lib/execution/execute";
import { SWAP_ROUTER_ABI, ERC20_ABI } from "@/lib/execution/abis";
import { verifyDelivery } from "@/lib/execution/verify";
import {
  priceImpactState,
  resolveExecutionProtection,
  resolveMevProtection,
} from "@/lib/domain/protection";
import { QUOTE_MAX_AGE_MS } from "@/lib/domain/freshness";
import { getToken } from "@/lib/config/tokens";
import { parseUnits } from "@/lib/domain/math";
import type { Balance, Quote, QuoteResult } from "@/lib/domain/intent";
import {
  initialIntent,
  reduceIntent,
  executionKey,
  type CanonicalIntent,
} from "@/lib/domain/canonicalIntent";

/**
 * End-to-end execution-safety matrix (A–O).
 *
 * Every protection the product promises is asserted at the layer that actually
 * enforces it — calldata, the signing guard, or receipt verification — never
 * from a UI label.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222" as const;

const USDC = getToken("USDC")!;
const USDT = getToken("USDT")!;
const MON = getToken("MON")!;

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function pad(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}
function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function swapIntent(overrides: Partial<CanonicalIntent> = {}): CanonicalIntent {
  return {
    ...reduceIntent(initialIntent(), {
      recipient: RECIPIENT,
      receiveToken: "USDC",
      receiveAmount: "5",
      payToken: "USDT",
      payTokenSource: "user",
    }),
    ...overrides,
  };
}

/** An exact-input swap quote paying USDT for USDC with a real live route. */
function swapQuote(intent: CanonicalIntent, priceImpact: number | null, quotedAt = Date.now()): Quote {
  return {
    intent: {
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveAmount: intent.receiveAmount,
      amountMode: intent.amountMode,
    },
    network: intent.network,
    payToken: USDT,
    receiveToken: USDC,
    payAmount: "5.01",
    receiveAmount: "5",
    payUsd: 5.01,
    receiveUsd: 5,
    rate: 1,
    priceImpact,
    route: {
      kind: "swap",
      hops: [
        { fromSymbol: "USDT", toSymbol: "USDC", fee: 100, pool: "0x0000000000000000000000000000000000000001" },
      ],
      path: ["USDT", "USDC"],
      tokens: [USDT, USDC],
    },
    totalSenderCostUsd: 5.02,
    networkCostUsd: 0.01,
    quotedAt,
    exactOutput: false,
  };
}

function fetchers(
  intent: CanonicalIntent,
  quote: Quote,
  overrides: Partial<SigningFetchers> = {},
): SigningFetchers {
  return {
    fetchBalances: async (): Promise<Balance[]> => [
      { token: USDT, amount: "100", usd: 100 },
      { token: MON, amount: "1", usd: 0.03 },
    ],
    fetchQuote: async (): Promise<QuoteResult> => ({ ok: true, quote }),
    resolveGas: async () => "native",
    readGas: async () => ({ gasLimit: 200_000n, gasPriceWei: 100_000_000_000n }),
    readIntent: () => intent,
    readAccount: () => SENDER,
    ...overrides,
  };
}

function fakeClient(receipts: Record<string, any>, txs: Record<string, any> = {}): PublicClient {
  return {
    getTransactionReceipt: async ({ hash }: any) => {
      const r = receipts[hash];
      if (!r) throw new Error("not found");
      return r;
    },
    getTransaction: async ({ hash }: any) => txs[hash] ?? null,
  } as unknown as PublicClient;
}

// ---------------------------------------------------------------------------
// SwapRouter02 reality: no on-chain deadline
// ---------------------------------------------------------------------------

describe("SwapRouter02 has no on-chain deadline (honest)", () => {
  it("encodes the deadline-less selector the Monad router actually exposes", () => {
    const q = swapQuote(swapIntent(), 0.001);
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 100);
    const swap = plan.steps.find((s) => s.kind === "swap")!;
    const call = encodeStep(swap);
    // 0x04e45aaf is exactInputSingle on the deployed SwapRouter02; the
    // with-deadline variant (0x0457d914) does not exist on-chain and reverts.
    expect(call.data!.slice(0, 10)).toBe("0x04e45aaf");
  });

  it("the ABI does not carry a deadline parameter (adding one would revert)", () => {
    const abi = SWAP_ROUTER_ABI as readonly any[];
    for (const fn of abi) {
      if (fn.type !== "function") continue;
      const paramNames = (fn.inputs ?? []).map((i: any) => i.name);
      expect(paramNames, fn.name).not.toContain("deadline");
    }
    // The selector the ABI produces matches the deployed router's.
    const exactInputSingle = abi.find((f) => f.name === "exactInputSingle")!;
    expect(toFunctionSelector(exactInputSingle)).toBe("0x04e45aaf");
  });

  it("reports the on-chain deadline as unavailable rather than faking it", () => {
    const p = resolveExecutionProtection(0.002, 50);
    expect(p.onchainDeadlineSupported).toBe(false);
  });
});

describe("post-confirmation finality", () => {
  it("waits for Monad full finality (2 blocks) before confirming a step", () => {
    expect(FINALITY_CONFIRMATIONS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Capability states (never a bare boolean)
// ---------------------------------------------------------------------------

describe("explicit capability states", () => {
  it("reports PRICE_IMPACT_PROTECTION_ACTIVE only when an impact was measured", () => {
    expect(priceImpactState({ value: 0.001, max: 0.03, ok: true, blocked: false, bps: 10 })).toBe(
      "PRICE_IMPACT_PROTECTION_ACTIVE",
    );
  });

  it("reports PRICE_IMPACT_PROTECTION_UNAVAILABLE when it could not be measured", () => {
    expect(priceImpactState({ value: null, max: 0.03, ok: true, blocked: false, bps: null })).toBe(
      "PRICE_IMPACT_PROTECTION_UNAVAILABLE",
    );
  });

  it("surfaces the freshness window and the price-impact state together", () => {
    const p = resolveExecutionProtection(0.002, 50);
    expect(p.slippage.state).toBe("SLIPPAGE_PROTECTION_ACTIVE");
    expect(p.freshnessMs).toBe(QUOTE_MAX_AGE_MS);
    expect(p.priceImpact.state).toBe("PRICE_IMPACT_PROTECTION_ACTIVE");
    expect(p.onchainDeadlineSupported).toBe(false);
  });

  it("L: private/MEV submission is unavailable and reported honestly", () => {
    const mev = resolveMevProtection();
    expect(mev.state).toBe("MEV_PROTECTION_UNAVAILABLE");
    expect(mev.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A–O matrix
// ---------------------------------------------------------------------------

describe("execution-safety matrix", () => {
  it("A: normal execution within slippage is allowed and carries an on-chain bound", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, slippageBps: 100 },
      fetchers(intent, swapQuote(intent, 0.004)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const swap = result.plan.steps.find((s) => s.kind === "swap")!;
      expect(swap.kind === "swap" && swap.amountOutMinimum).toBe(parseUnits("4.95", 6));
      expect(planHasOutputBound(result.plan)).toBe(true);
    }
  });

  it("B: a swap with no on-chain bound is refused, and an under-minimum fill is not verified", async () => {
    // The bound itself is the enforcement: without it the plan is refused.
    const q = swapQuote(swapIntent(), 0.001);
    const plan = buildPaymentPlan(q, SENDER, RECIPIENT, 100);
    const unbounded = {
      ...plan,
      steps: plan.steps.map((s) =>
        s.kind === "swap" ? { ...s, amountOutMinimum: 0n } : s,
      ),
    };
    expect(planHasOutputBound(unbounded)).toBe(false);

    // And a fill that lands below the enforced floor is never reported verified.
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER_ACCOUNT), pad(RECIPIENT)],
          data: word(4_900_000n), // 4.90 < 4.95 floor
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
      100n,
    );
    expect(check.verified).toBe(false);
  });

  it("C: excessive price impact is blocked before signing", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers(intent, swapQuote(intent, 0.5)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("price_impact");
  });

  it("D: a stale quote is blocked before signing", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers(intent, swapQuote(intent, 0.001, Date.now() - 60_000)),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quote_stale");
  });

  it("E: changing the recipient invalidates the old build", async () => {
    const intent = swapIntent();
    const edited = reduceIntent(intent, { recipient: OTHER_ACCOUNT });
    expect(edited.version).toBeGreaterThan(intent.version);
    expect(edited.key).not.toBe(intent.key);
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers(intent, swapQuote(intent, 0.001), { readIntent: () => edited }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("intent_changed");
  });

  it("F: changing the amount invalidates the old build", async () => {
    const intent = swapIntent();
    const edited = reduceIntent(intent, { receiveAmount: "50" });
    expect(edited.key).not.toBe(intent.key);
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers(intent, swapQuote(intent, 0.001), { readIntent: () => edited }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("intent_changed");
  });

  it("G: changing the input asset invalidates the old build", () => {
    const intent = swapIntent();
    const edited = reduceIntent(intent, { payToken: "USDC", payTokenAddress: USDC.address });
    expect(edited.version).toBeGreaterThan(intent.version);
    expect(edited.key).not.toBe(intent.key);
  });

  it("H: changing the output asset invalidates the old build", () => {
    const intent = swapIntent();
    const edited = reduceIntent(intent, { receiveToken: "MON" });
    expect(edited.version).toBeGreaterThan(intent.version);
    expect(edited.key).not.toBe(intent.key);
  });

  it("I: a wallet/account change invalidates the old build", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers(intent, swapQuote(intent, 0.001), { readAccount: () => OTHER_ACCOUNT }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("account_changed");
  });

  it("J: a network change invalidates the old build", () => {
    const intent = swapIntent();
    const base = { ...intent, network: "mainnet" as const };
    const other = { ...base, network: "testnet" as any };
    // The network is part of the execution key, so a chain switch can never
    // reuse a quote or a transaction.
    expect(executionKey(base)).not.toBe(executionKey(other));
  });

  it("M: a successful confirmation whose transfer reaches the recipient is verified", async () => {
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER_ACCOUNT), pad(RECIPIENT)],
          data: word(4_960_000n), // within the 1% floor of 4.95
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
      100n,
    );
    expect(check.verified).toBe(true);
    expect(check.delivered).toBe("4.96");
  });

  it("N: a reverted transaction is never marked successful", async () => {
    const check = await verifyDelivery(
      fakeClient({ "0xabc": { status: "reverted", logs: [] } }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
    );
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/no successful receipt/i);
  });

  it("O: unverifiable delivery is never falsely marked successful", async () => {
    const none = await verifyDelivery(fakeClient({}), [], USDC, RECIPIENT, "5");
    expect(none.verified).toBe(false);

    const missing = await verifyDelivery(
      fakeClient({}),
      ["0xmissing" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
    );
    expect(missing.verified).toBe(false);
    expect(missing.reason).toMatch(/no successful receipt/i);
  });
});

describe("ERC-20 Transfer event remains decodable (verification depends on it)", () => {
  it("decodes a Transfer log", () => {
    const decoded = decodeEventLog({
      abi: ERC20_ABI,
      topics: [TRANSFER_TOPIC, pad(OTHER_ACCOUNT), pad(RECIPIENT)] as [
        `0x${string}`,
        ...`0x${string}`[],
      ],
      data: word(5_000_000n) as `0x${string}`,
    });
    expect((decoded.args as any).to.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });
});
