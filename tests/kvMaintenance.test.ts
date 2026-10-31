import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, setStore } from "@/lib/store";
import { sweepExpiredKv } from "@/lib/server/kvMaintenance";
import { HELD_PREFIX, SPENT_PREFIX } from "@/lib/server/aiBudgetKeys";

/**
 * The opportunistic maintenance sweep must stay bounded and must never delete
 * the monthly AI-spend counter — doing so would silently reset the hard budget.
 * The per-window reservation counters (`aib:held:*`) are dead once past the max
 * window and are swept; the rate-limit windows and old telemetry are swept too.
 */

const NOW = 100 * 24 * 60 * 60 * 1000;
const OLD = NOW - 40 * 24 * 60 * 60 * 1000; // 40 days ago: older than every retention.

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  setStore(new MemoryStore());
});

describe("kv maintenance sweep", () => {
  it("preserves the monthly spent counter but sweeps dead holds and stale rows", async () => {
    const store = new MemoryStore();
    setStore(store);
    await store.insert("counters", { key: `${SPENT_PREFIX}:2026-01`, value: 12345, updatedAt: OLD });
    await store.insert("counters", { key: `${HELD_PREFIX}:2026-01:1`, value: 999, updatedAt: OLD });
    await store.insert("counters", { key: "rl:quote:1.2.3.4:5", value: 3, updatedAt: OLD });
    await store.insert("counters", { key: "rl:fresh:1.2.3.4:9", value: 1, updatedAt: NOW });
    await store.insert("kv", { key: "rl:referral:1.2.3.4:5", value: "2", updatedAt: OLD });
    await store.insert("kv", { key: "nonce:dead", value: JSON.stringify({ exp: OLD }), updatedAt: OLD });
    await store.insert("opsEvents", {
      id: "old",
      at: OLD,
      severity: "error",
      category: "provider_error",
      service: "api/nlp",
      message: null,
      attemptId: null,
      unresolved: true,
    });
    await store.insert("opsEvents", {
      id: "fresh",
      at: NOW,
      severity: "error",
      category: "provider_error",
      service: "api/nlp",
      message: null,
      attemptId: null,
      unresolved: true,
    });

    sweepExpiredKv(NOW);
    await tick();

    // The budget is intact.
    expect(await store.findOne("counters", { key: `${SPENT_PREFIX}:2026-01` })).toBeTruthy();
    // Dead reservations and windows are gone.
    expect(await store.findOne("counters", { key: `${HELD_PREFIX}:2026-01:1` })).toBeUndefined();
    expect(await store.findOne("counters", { key: "rl:quote:1.2.3.4:5" })).toBeUndefined();
    expect(await store.findOne("kv", { key: "rl:referral:1.2.3.4:5" })).toBeUndefined();
    expect(await store.findOne("kv", { key: "nonce:dead" })).toBeUndefined();
    // Fresh rows survive.
    expect(await store.findOne("counters", { key: "rl:fresh:1.2.3.4:9" })).toBeTruthy();
    // Old telemetry is pruned; recent telemetry is kept.
    expect(await store.findOne("opsEvents", { id: "old" })).toBeUndefined();
    expect(await store.findOne("opsEvents", { id: "fresh" })).toBeTruthy();
  });

  it("is bounded: a large table does not read more than one batch per sweep", async () => {
    const store = new MemoryStore();
    setStore(store);
    // More rows than a single batch (SWEEP_BATCH = 2000).
    const big = 2_500;
    const inserts: Promise<void>[] = [];
    for (let i = 0; i < big; i++) {
      inserts.push(store.insert("counters", { key: `rl:b:1.1.1.1:${i}`, value: 1, updatedAt: OLD }));
    }
    await Promise.all(inserts);

    // Spy on how many rows the sweep reads.
    const original = store.findMany.bind(store);
    let maxRead = 0;
    store.findMany = (async (table: any, where: any, opts: any) => {
      const rows = await original(table, where, opts);
      if (table === "counters") maxRead = Math.max(maxRead, rows.length);
      return rows;
    }) as typeof store.findMany;

    sweepExpiredKv(NOW);
    await tick();

    // The counters read is capped at one batch, so a huge table cannot spike
    // memory or latency.
    expect(maxRead).toBeLessThanOrEqual(2_000);
  });
});
