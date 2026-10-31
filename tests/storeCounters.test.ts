import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, SqliteStore, type Store } from "@/lib/store";

/**
 * The atomic integer counter primitive.
 *
 * The rate limiter's correctness rests on `incrementInt`: it must add exactly
 * once per call, under concurrency, and clamp at zero. A read-modify-write
 * implementation would let a burst of callers each read the same value and all
 * succeed, so the concurrency assertion is the point of this file.
 */

async function exerciseIncrement(store: Store): Promise<void> {
  await store.incrementInt("counters", { key: "k" }, "value", 1, { key: "k", value: 1, updatedAt: 1 });
  const row = await store.findOne("counters", { key: "k" });
  expect(row?.value).toBe(1);

  // A concurrent burst must not lose an increment.
  await Promise.all(
    Array.from({ length: 100 }, () =>
      store.incrementInt("counters", { key: "k" }, "value", 1, { key: "k", value: 1, updatedAt: 1 }),
    ),
  );
  expect((await store.findOne("counters", { key: "k" }))?.value).toBe(101);

  // It clamps at zero.
  await store.incrementInt("counters", { key: "k" }, "value", -500, { key: "k", value: 1, updatedAt: 1 });
  expect((await store.findOne("counters", { key: "k" }))?.value).toBe(0);
}

describe("Store.incrementInt (memory)", () => {
  it("increments exactly, even concurrently", async () => {
    await exerciseIncrement(new MemoryStore());
  });
});

describe("Store.incrementInt (sqlite)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "intent-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("increments exactly, even concurrently", async () => {
    const store = new SqliteStore(join(dir, "store.db"));
    await exerciseIncrement(store);
  });
});
