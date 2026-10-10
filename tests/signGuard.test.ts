import { describe, expect, it } from "vitest";
import {
  prepareSigning,
  quoteMatchesIntent,
  coversBalance,
  coversGas,
  planHasOutputBound,
  type SigningFetchers,
} from "@/lib/execution/signGuard";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { INSUFFICIENT_MON_FOR_FEES_MESSAGE } from "@/lib/domain/transactionError";
import { createLatestGuard } from "@/lib/domain/latest";
import { getToken } from "@/lib/config/tokens";
import type { Balance, Quote, QuoteResult } from "@/lib/domain/intent";
import {
  initialIntent,
  reduceIntent,
  type CanonicalIntent,
} from "@/lib/domain/canonicalIntent";

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222" as const;

const USDC = getToken("USDC")!;
const MON = getToken("MON")!;

/** A complete, valid intent for the guard: pay 5 USDC to the recipient. */
function validIntent(overrides: Partial<CanonicalIntent> = {}): CanonicalIntent {
  return {
    ...reduceIntent(initialIntent(), {
      recipient: RECIPIENT,
      receiveToken: "USDC",
      receiveAmount: "5",
      payToken: "USDC",
      payTokenSource: "user",
    }),
    ...overrides,
  };
}

/** A direct same-asset quote (no live liquidity needed) — executable & stable. */
function directQuote(intent: CanonicalIntent, quotedAt = Date.now()): Quote {
  return {
    intent: {
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveAmount: intent.receiveAmount,
      amountMode: intent.amountMode,
    },
    network: intent.network,
    payToken: USDC,
    receiveToken: USDC,
    payAmount: "5",
    receiveAmount: "5",
    payUsd: 5,
    receiveUsd: 5,
    rate: 1,
    route: { kind: "direct", hops: [], path: ["USDC", "USDC"] },
    totalSenderCostUsd: 5.01,
    networkCostUsd: 0.01,
    quotedAt,
    exactOutput: false,
  };
}

/** An exact-input swap quote whose tokens match the intent, with a measurable
 * price impact. */
function swapQuote(intent: CanonicalIntent, priceImpact: number | null): Quote {
  const usdt = getToken("USDT")!;
  const receive = getToken(intent.receiveToken) ?? getToken("USDC")!;
  return {
    intent: {
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveAmount: intent.receiveAmount,
      amountMode: intent.amountMode,
    },
    network: intent.network,
    payToken: usdt,
    receiveToken: receive,
    payAmount: "5.01",
    receiveAmount: "5",
    payUsd: 5.01,
    receiveUsd: 5,
    rate: 1,
    priceImpact,
    route: {
      kind: "swap",
      hops: [{ fromSymbol: "USDT", toSymbol: receive.symbol, fee: 100, pool: "0x0000000000000000000000000000000000000001" }],
      path: ["USDT", receive.symbol],
      tokens: [usdt, receive],
    },
    totalSenderCostUsd: 5.02,
    networkCostUsd: 0.01,
    quotedAt: Date.now(),
    exactOutput: false,
  };
}

/** An intent that pays USDT and receives USDC, matching `swapQuote`. */
function swapIntent(): CanonicalIntent {
  return {
    ...reduceIntent(initialIntent(), {
      recipient: RECIPIENT,
      receiveToken: "USDC",
      receiveAmount: "5",
      payToken: "USDT",
      payTokenSource: "user",
    }),
  };
}

function balances(amount = "100"): Balance[] {
  return [
    { token: USDC, amount, usd: Number(amount) },
    { token: MON, amount: "1", usd: 0.03 },
  ];
}

function fetchers(overrides: Partial<SigningFetchers> & { quote?: QuoteResult } = {}): SigningFetchers {
  const intent = overrides.readIntent?.() ?? validIntent();
  const { quote, ...rest } = overrides;
  return {
    fetchBalances: async () => balances(),
    fetchQuote: async () => quote ?? { ok: true, quote: directQuote(intent) },
    resolveGas: async () => "native",
    readGas: async () => ({ gasLimit: 200_000n, gasPriceWei: 100_000_000_000n }),
    readIntent: () => intent,
    readAccount: () => SENDER,
    ...rest,
  };
}

describe("signing safety pipeline — the invariant", () => {
  it("builds a fresh plan when intent, version, account and quote all hold", async () => {
    const intent = validIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({ readIntent: () => intent }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version).toBe(intent.version);
      expect(result.key).toBe(intent.key);
      expect(result.plan.executable).toBe(true);
      expect(result.plan.steps[0].kind).toBe("transfer");
    }
  });

  // H. Quote becoming stale.
  it("blocks when the fresh quote is already stale (H)", async () => {
    const intent = validIntent();
    const stale = directQuote(intent, Date.now() - 60_000);
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({ readIntent: () => intent, quote: { ok: true, quote: stale } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quote_stale");
  });

  // J. User edits the intent immediately before signing.
  it("aborts when the intent changed before signing (J)", async () => {
    const intent = validIntent();
    const edited = reduceIntent(intent, { receiveAmount: "20" });
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({ readIntent: () => edited }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("intent_changed");
      expect(result.expectedVersion).toBe(intent.version);
      expect(result.actualVersion).toBe(edited.version);
    }
  });

  // K. Intent changes while transaction preparation is running.
  it("aborts when the intent changes mid-preparation (K)", async () => {
    const intent = validIntent();
    const edited = reduceIntent(intent, { recipient: OTHER_ACCOUNT });
    let reads = 0;
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({
        // First read (after fetching) sees the old intent; the final read sees
        // the edit that landed during plan construction.
        readIntent: () => (reads++ === 0 ? intent : edited),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("intent_changed");
  });

  // L. Wallet changes accounts immediately before signing.
  it("aborts when the wallet account changed before signing (L)", async () => {
    const intent = validIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({ readIntent: () => intent, readAccount: () => OTHER_ACCOUNT }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("account_changed");
  });

  // N. The wallet's MON balance cannot cover the network fee at signing time.
  it("blocks when the wallet does not hold enough MON to pay the network fee (N)", async () => {
    const intent = validIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({
        readIntent: () => intent,
        resolveGas: async () => "native",
        // No native balance and a real gas estimate: the wallet can't pay.
        fetchBalances: async () => [{ token: USDC, amount: "100", usd: 100 }],
        readGas: async () => ({ gasLimit: 200_000n, gasPriceWei: 100_000_000_000n }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("insufficient_gas");
      // The guard must not invent its own fee-shortfall copy — the same single
      // approved message is shown wherever a fee shortfall is reported.
      expect(result.message).toBe(INSUFFICIENT_MON_FOR_FEES_MESSAGE);
    }
  });

  it("allows signing when the wallet holds enough MON for the network fee", async () => {
    const intent = validIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({
        readIntent: () => intent,
        resolveGas: async () => "native",
        readGas: async () => ({ gasLimit: 200_000n, gasPriceWei: 100_000_000_000n }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks when a fresh quote can no longer be obtained", async () => {
    const intent = validIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({
        readIntent: () => intent,
        quote: { ok: false, code: "route_unavailable", message: "no route" },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("quote_unavailable");
  });

  it("blocks when the fresh balance no longer covers the payment", async () => {
    const intent = validIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({
        readIntent: () => intent,
        fetchBalances: async () => [{ token: USDC, amount: "1", usd: 1 }, { token: MON, amount: "1", usd: 0.03 }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_balance");
  });

  it("blocks when the quote describes a different intent (mismatch)", async () => {
    const intent = validIntent();
    const other = validIntent({ recipient: OTHER_ACCOUNT });
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({ readIntent: () => intent, quote: { ok: true, quote: directQuote(other) } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("intent_mismatch");
  });

  // C. Excessive price impact is blocked before signing.
  it("blocks a route whose price impact exceeds the ceiling (C)", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({
        readIntent: () => intent,
        quote: { ok: true, quote: swapQuote(intent, 0.5) }, // 50% >> 3%
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("price_impact");
  });

  // A. A route within slippage/impact builds a protected plan and is allowed.
  it("allows a swap within the impact ceiling and encodes an on-chain bound (A)", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, slippageBps: 100 },
      fetchers({
        readIntent: () => intent,
        quote: { ok: true, quote: swapQuote(intent, 0.004) }, // 0.4%
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const swap = result.plan.steps.find((s) => s.kind === "swap")!;
      expect(swap.kind === "swap" && swap.amountOutMinimum).toBeGreaterThan(0n);
      expect(result.plan.slippageBps).toBe(100);
    }
  });

  it("does not block a swap whose impact could not be measured", async () => {
    const intent = swapIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers({ readIntent: () => intent, quote: { ok: true, quote: swapQuote(intent, null) } }),
    );
    expect(result.ok).toBe(true);
  });

  // B. A swap plan with no on-chain bound is refused (never signed unprotected).
  it("refuses a plan whose swap carries no on-chain output bound (B)", () => {
    const q = swapQuote(swapIntent(), 0.001);
    const boundless = buildPaymentPlan(q, SENDER, RECIPIENT);
    expect(planHasOutputBound(boundless)).toBe(true); // real plan has a bound

    // Force a bound-less exact-in swap: the guard must reject it.
    const unprotected = {
      ...boundless,
      steps: boundless.steps.map((s) =>
        s.kind === "swap" ? { ...s, amountOutMinimum: 0n } : s,
      ),
    };
    expect(planHasOutputBound(unprotected)).toBe(false);
  });
});

describe("signing guard helpers", () => {
  it("quoteMatchesIntent compares recipient, tokens, amount and network", () => {
    const intent = validIntent();
    expect(quoteMatchesIntent(directQuote(intent), intent)).toBe(true);
    expect(quoteMatchesIntent(directQuote(intent), validIntent({ receiveAmount: "6" }))).toBe(false);
    expect(quoteMatchesIntent(directQuote(intent), validIntent({ recipient: OTHER_ACCOUNT }))).toBe(false);
  });

  it("coversBalance tolerates an unread balance but blocks a real shortfall", () => {
    const quote = directQuote(validIntent());
    expect(coversBalance([], quote)).toBe(true);
    expect(coversBalance([{ token: USDC, amount: "4.99", usd: 4.99 }], quote)).toBe(false);
    expect(coversBalance([{ token: USDC, amount: "5", usd: 5 }], quote)).toBe(true);
  });

  it("coversGas treats an unread balance as unknown but blocks a wallet with no MON", () => {
    // Nothing read at all → unknown, don't block.
    expect(coversGas([], undefined, undefined)).toBe(true);
    // Balances read but no native entry → the wallet holds no MON.
    expect(coversGas([{ token: USDC, amount: "100", usd: 100 }], 200_000n, 100_000_000_000n)).toBe(false);
    // A real MON balance that covers the (buffered) fee.
    expect(coversGas([{ token: MON, amount: "1", usd: 0.03 }], 200_000n, 100_000_000_000n)).toBe(true);
    // A dust MON balance that does not.
    expect(
      coversGas([{ token: MON, amount: "0.0001", usd: 0 }], 200_000n, 100_000_000_000n),
    ).toBe(false);
  });
});

/**
 * I. A slow route request followed by a newer route request: the older one must
 * not be able to write to state once the newer request has been issued.
 */
describe("latest-only request guard (I)", () => {
  it("lets only the newest request for the current version update state", async () => {
    const guard = createLatestGuard();
    const write = async (delayMs: number, value: string) => {
      await new Promise((r) => setTimeout(r, delayMs));
      return value;
    };

    // Request A is slow; request B is issued (and resolves) first.
    const idA = guard.issue(1);
    const idB = guard.issue(1);
    const b = await write(5, "B");
    const a = await write(30, "A");

    const applied: string[] = [];
    if (guard.isCurrent(idB, 1)) applied.push(b);
    if (guard.isCurrent(idA, 1)) applied.push(a);

    expect(applied).toEqual(["B"]);
  });

  it("rejects a result issued for an older intent version", () => {
    const guard = createLatestGuard();
    const id = guard.issue(1);
    // The intent has moved on to version 2; the version-1 result is stale.
    expect(guard.isCurrent(id, 2)).toBe(false);
  });

  it("invalidate() prevents any outstanding request from writing", () => {
    const guard = createLatestGuard();
    const id = guard.issue(3);
    guard.invalidate();
    expect(guard.isCurrent(id, 3)).toBe(false);
  });
});

