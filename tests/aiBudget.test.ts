import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStore } from "@/lib/store";
import { setMonthlyBudgetUsd, estimateCostUsd, costSummary } from "@/lib/server/cost";
import {
  reserveLlmBudget,
  settleLlmBudget,
  releaseLlmBudget,
  runBudgetedIntentHint,
  llmBudgetSnapshot,
  reservationMicro,
  HELD_PREFIX,
  SPENT_PREFIX,
  RESERVATION_WINDOW_MS,
} from "@/lib/server/aiBudget";
import { LLM_MAX_INPUT_TOKENS_ESTIMATE, LLM_MAX_OUTPUT_TOKENS } from "@/lib/nlp/llm";
import { recentOps } from "@/lib/server/ops";
import type { ParseHint } from "@/lib/nlp/parser";

/**
 * Hard AI budget enforcement.
 *
 * The advisory `budgetState` check is not a limit — concurrent requests all read
 * the same lagging rollup and all proceed. These tests lock the *hard* guarantee:
 * atomic reservations bound the number of concurrent paid calls so the total
 * spend cannot exceed the configured budget, and a leaked reservation ages out
 * rather than consuming budget forever.
 *
 * No fake accounting: the figures are the module's own worst-case estimate from
 * the real price table, and the assertions are on the real counters.
 */

const MODEL = "gpt-4o-mini";
const R = reservationMicro(MODEL);
/** A budget of exactly three reservations. */
const BUDGET_THREE = (R * 3) / 1_000_000;

beforeEach(() => {
  setStore(new MemoryStore());
});

describe("reserveLlmBudget", () => {
  it("refuses when the budget is exhausted", async () => {
    // A budget of exactly one worst-case call.
    await setMonthlyBudgetUsd(R / 1_000_000);
    // Spend the whole budget on one settled call.
    const first = await reserveLlmBudget({ model: MODEL });
    expect(first.ok).toBe(true);
    if (first.ok) {
      await settleLlmBudget(first.reservation, { model: MODEL, inputTokens: LLM_MAX_INPUT_TOKENS_ESTIMATE, outputTokens: LLM_MAX_OUTPUT_TOKENS });
    }
    // The spent counter now equals the budget, so the next reservation is refused.
    const next = await reserveLlmBudget({ model: MODEL });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason).toBe("budget_exhausted");
  });

  it("admits while budget remains, and does not spend on the create path", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const a = await reserveLlmBudget({ model: MODEL });
    expect(a.ok).toBe(true);
    // Held is the reservation; spent stays 0 until settlement.
    const snap = await llmBudgetSnapshot();
    expect(snap.spentUsd).toBe(0);
    expect(snap.heldUsd).toBeGreaterThan(0);
    expect(snap.remainingUsd).toBeLessThan(BUDGET_THREE);
  });

  it("is not enforced when no budget is configured (prior behaviour preserved)", async () => {
    const r = await reserveLlmBudget({ model: MODEL });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reservation.enforced).toBe(false);
    const snap = await llmBudgetSnapshot();
    expect(snap.enforced).toBe(false);
    expect(snap.remainingUsd).toBeNull();
  });
});

describe("concurrency", () => {
  it("concurrent reservations cannot all pass a budget that fits only a few", async () => {
    // A budget of exactly three reservations; fire far more concurrently.
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => reserveLlmBudget({ model: MODEL })),
    );
    const granted = outcomes.filter((o) => o.ok);
    // Never more than the budget allows — the hard guarantee.
    expect(granted.length).toBeLessThanOrEqual(3);
    expect(granted.length).toBeGreaterThan(0);
    // Every refusal is the honest reason.
    for (const o of outcomes) if (!o.ok) expect(o.reason).toBe("budget_exhausted");

    // Settle every granted reservation for its worst case, then the *effective*
    // spend must not exceed the budget.
    for (const o of granted) {
      if (o.ok) {
        await settleLlmBudget(o.reservation, { model: MODEL, inputTokens: LLM_MAX_INPUT_TOKENS_ESTIMATE, outputTokens: LLM_MAX_OUTPUT_TOKENS });
      }
    }
    const snap = await llmBudgetSnapshot();
    expect(snap.spentUsd).toBeLessThanOrEqual(BUDGET_THREE + 1e-9);
    // The budget is now exhausted: no further reservation is granted.
    expect((await reserveLlmBudget({ model: MODEL })).ok).toBe(false);
  });
});

describe("reservation lifecycle", () => {
  it("releases the hold on failure so it does not consume budget", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const r = await reserveLlmBudget({ model: MODEL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await llmBudgetSnapshot()).heldUsd).toBeGreaterThan(0);
    await releaseLlmBudget(r.reservation);
    expect((await llmBudgetSnapshot()).heldUsd).toBe(0);
    // A failed call therefore leaves the budget fully available again.
    expect((await reserveLlmBudget({ model: MODEL })).ok).toBe(true);
  });

  it("reconciles the reservation down to the actual cost", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const r = await reserveLlmBudget({ model: MODEL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A tiny actual cost: the held difference is released, spent reflects reality.
    await settleLlmBudget(r.reservation, { model: MODEL, inputTokens: 10, outputTokens: 5 });
    const actual = estimateCostUsd(MODEL, 10, 5);
    const snap = await llmBudgetSnapshot();
    expect(snap.spentUsd).toBeCloseTo(actual, 6);
    expect(snap.heldUsd).toBe(0);
  });

  it("a leaked reservation (no settle/release) ages out of the lookback window", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const t0 = 10 * RESERVATION_WINDOW_MS;
    const r = await reserveLlmBudget({ model: MODEL, now: t0 });
    expect(r.ok).toBe(true);
    // Two windows later the leaked hold is no longer counted.
    const snap = await llmBudgetSnapshot(t0 + 2 * RESERVATION_WINDOW_MS);
    expect(snap.heldUsd).toBe(0);
  });
});

describe("runBudgetedIntentHint", () => {
  const symbols = ["MON", "USDC"];
  const hint: ParseHint = { patch: { amount: "10" }, source: "llm" };

  beforeEach(() => {
    process.env.INTENT_LLM_API_KEY = "test-key";
  });

  it("returns the hint and settles usage when the budget admits the call", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const caller = vi.fn(async (_t: string, _s: string[], onUsage?: (u: any) => void | Promise<void>) => {
      await onUsage?.({ model: MODEL, inputTokens: 100, outputTokens: 20 });
      return hint;
    });
    const result = await runBudgetedIntentHint("send 10 usdc", symbols, { caller });
    expect(result).toEqual(hint);
    expect(caller).toHaveBeenCalledOnce();
    const snap = await llmBudgetSnapshot();
    expect(snap.spentUsd).toBeCloseTo(estimateCostUsd(MODEL, 100, 20), 6);
    expect(snap.heldUsd).toBe(0);
  });

  it("skips the paid call when the budget is exhausted (deterministic fallback)", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    // Exhaust it.
    for (let i = 0; i < 3; i++) {
      const r = await reserveLlmBudget({ model: MODEL });
      if (r.ok) await settleLlmBudget(r.reservation, { model: MODEL, inputTokens: LLM_MAX_INPUT_TOKENS_ESTIMATE, outputTokens: LLM_MAX_OUTPUT_TOKENS });
    }
    const caller = vi.fn(async () => hint);
    const result = await runBudgetedIntentHint("send 10 usdc", symbols, { caller });
    expect(result).toBeNull();
    expect(caller).not.toHaveBeenCalled();
    // The skip is recorded, not silent.
    const ops = await recentOps(60_000);
    expect(ops.events.some((e) => /budget exhausted/i.test(e.message ?? ""))).toBe(true);
  });

  it("releases the reservation when the provider call throws", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const caller = vi.fn(async () => {
      throw new Error("provider blew up");
    });
    const result = await runBudgetedIntentHint("send 10 usdc", symbols, { caller });
    expect(result).toBeNull();
    expect((await llmBudgetSnapshot()).heldUsd).toBe(0);
  });

  it("releases the reservation when the provider returns null (failure after reservation)", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const caller = vi.fn(async () => null);
    const result = await runBudgetedIntentHint("send 10 usdc", symbols, { caller });
    expect(result).toBeNull();
    expect((await llmBudgetSnapshot()).heldUsd).toBe(0);
  });

  it("releases the reservation when a success reports no usage", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const caller = vi.fn(async () => hint); // never calls onUsage
    const result = await runBudgetedIntentHint("send 10 usdc", symbols, { caller });
    expect(result).toEqual(hint);
    expect((await llmBudgetSnapshot()).heldUsd).toBe(0);
  });

  it("never runs the LLM when no provider is configured", async () => {
    delete process.env.INTENT_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const caller = vi.fn(async () => hint);
    const result = await runBudgetedIntentHint("send 10 usdc", symbols, { caller });
    expect(result).toBeNull();
    expect(caller).not.toHaveBeenCalled();
  });
});

describe("store failure", () => {
  it("skips the paid call (fail-closed for the LLM) and records why", async () => {
    process.env.INTENT_LLM_API_KEY = "test-key";
    await setMonthlyBudgetUsd(BUDGET_THREE);
    // A store that throws on every read/write of the budget counters.
    const broken = new MemoryStore();
    const boom = async () => {
      throw new Error("db down");
    };
    broken.findOne = boom as unknown as typeof broken.findOne;
    broken.incrementInt = boom as unknown as typeof broken.incrementInt;
    setStore(broken);

    const caller = vi.fn(async () => ({ patch: {}, source: "llm" }) as ParseHint);
    const result = await runBudgetedIntentHint("send 10 usdc", ["MON"], { caller });
    // The LLM is skipped — a store outage must not silently bypass the budget.
    expect(result).toBeNull();
    expect(caller).not.toHaveBeenCalled();
    expect((await reserveLlmBudget({ model: MODEL })).ok).toBe(false);
  });
});

describe("settlement writes the reporting rollup", () => {
  it("records the true cost into the cost summary", async () => {
    await setMonthlyBudgetUsd(BUDGET_THREE);
    const r = await reserveLlmBudget({ model: MODEL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await settleLlmBudget(r.reservation, { model: MODEL, inputTokens: 1_000, outputTokens: 1_000 });
    const summary = await costSummary();
    expect(summary.today.requests).toBe(1);
    expect(Number(summary.today.estimatedCostUsd)).toBeCloseTo(estimateCostUsd(MODEL, 1_000, 1_000), 6);
  });
});

describe("counter key namespaces", () => {
  it("uses distinct held/spent prefixes so the sweep can protect spent", () => {
    expect(HELD_PREFIX).not.toBe(SPENT_PREFIX);
    expect(SPENT_PREFIX).toBe("aib:spent");
  });
});
