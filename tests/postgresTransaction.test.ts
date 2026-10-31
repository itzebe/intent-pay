import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Postgres transactions must be serialized.
 *
 * Regression: the adapter binds itself to a transaction's client via a single
 * shared `override` field. With two concurrent `transaction()` calls, the second
 * would overwrite that binding while the first was mid-flight — sending the first
 * transaction's statements to the second's connection (or the pool), silently
 * losing atomicity. The adapter now serializes transactions on a promise chain.
 *
 * The fake Pool records the global order of BEGIN/COMMIT and lets a statement
 * yield, so an interleaving would be observable.
 */
const h = vi.hoisted(() => {
  const state = { events: [] as string[] };
  const reset = () => {
    state.events = [];
  };
  const tick = () => new Promise((r) => setTimeout(r, 1));
  class FakeClient {
    private inTx = false;
    async query(text: string) {
      const t = text.trim();
      if (t === "BEGIN") {
        if (state.events.filter((e) => e === "BEGIN").length > state.events.filter((e) => e === "COMMIT").length) {
          state.events.push("INTERLEAVED");
        }
        this.inTx = true;
        state.events.push("BEGIN");
        await tick();
        return { rows: [], rowCount: 0 };
      }
      if (t === "COMMIT") {
        this.inTx = false;
        state.events.push("COMMIT");
        return { rows: [], rowCount: 0 };
      }
      if (t === "ROLLBACK") {
        this.inTx = false;
        state.events.push("ROLLBACK");
        return { rows: [], rowCount: 0 };
      }
      // A statement inside the transaction: yield so another task could run.
      state.events.push(`Q${this.inTx ? ":in" : ":out"}`);
      await tick();
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    async query(text: string) {
      return new FakeClient().query(text);
    }
    async connect() {
      return new FakeClient();
    }
  }
  return { state, reset, FakePool };
});

vi.mock("@neondatabase/serverless", () => ({ Pool: h.FakePool }));

import { PostgresStore } from "@/lib/store/postgres";

describe("PostgresStore.transaction serialization", () => {
  beforeEach(() => h.reset());

  it("never interleaves two concurrent transactions", async () => {
    const store = new PostgresStore("postgres://user@db.example/neondb");
    await Promise.all([
      store.transaction(async () => {
        await store.findOne("referralCodes", { code: "A" });
      }),
      store.transaction(async () => {
        await store.findOne("referralCodes", { code: "B" });
      }),
    ]);
    expect(h.state.events).not.toContain("INTERLEAVED");
    // Every BEGIN must close before the next BEGIN — strictly nested, never
    // overlapping (the lazy migration is itself one such pair).
    let depth = 0;
    for (const e of h.state.events) {
      if (e === "BEGIN") {
        expect(depth).toBe(0);
        depth = 1;
      } else if (e === "COMMIT" || e === "ROLLBACK") {
        expect(depth).toBe(1);
        depth = 0;
      }
    }
    expect(depth).toBe(0);
    expect(h.state.events.filter((e) => e === "BEGIN").length).toBe(
      h.state.events.filter((e) => e === "COMMIT").length,
    );
  });

  it("rolls back and surfaces the error when the body throws", async () => {
    const store = new PostgresStore("postgres://user@db.example/neondb");
    await expect(
      store.transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(h.state.events).toContain("ROLLBACK");
  });
});
