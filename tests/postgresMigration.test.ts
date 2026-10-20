import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fresh-database Postgres migration must not abort its own transaction.
 *
 * Regression: the migration probe read `_migrations` directly. On a brand-new
 * database that relation does not exist, so Postgres raised 42P01; although the
 * rejection was caught, the transaction was already aborted, so the following
 * `CREATE TABLE` failed with 25P02 and `migrate()` threw — leaving the schema
 * uncreated and `health()` reporting `ready:false` forever (the exact production
 * symptom: reachable:true, schemaReady:false, schemaVersion:null).
 *
 * The fake Pool below models real Postgres transaction-abort semantics, so a
 * regression to the direct `SELECT ... FROM "_migrations"` probe fails this test.
 */
const h = vi.hoisted(() => {
  const state = {
    tables: new Set<string>(),
    ledger: [] as number[],
    aborted: false,
    calls: [] as string[],
  };
  const reset = () => {
    state.tables.clear();
    state.ledger = [];
    state.aborted = false;
    state.calls = [];
  };
  const fail = (code: string, message: string) => {
    const e = new Error(message) as Error & { code?: string };
    e.code = code;
    return e;
  };
  class FakeClient {
    async query(text: string, values?: unknown[]) {
      const t = text.trim();
      state.calls.push(t);
      if (t === "BEGIN") {
        state.aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (t === "COMMIT" || t === "ROLLBACK") {
        state.aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (state.aborted) throw fail("25P02", "current transaction is aborted");
      if (t.startsWith("SELECT to_regclass")) {
        return { rows: [{ t: state.tables.has("_migrations") ? "_migrations" : null }], rowCount: 1 };
      }
      if (t.startsWith('SELECT "id" FROM "_migrations"')) {
        if (!state.tables.has("_migrations")) {
          state.aborted = true;
          throw fail("42P01", 'relation "_migrations" does not exist');
        }
        const id = Number(values?.[0]);
        return { rows: state.ledger.includes(id) ? [{ id }] : [], rowCount: 0 };
      }
      const create = t.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"/);
      if (create) {
        state.tables.add(create[1]);
        return { rows: [], rowCount: 0 };
      }
      if (t.startsWith("CREATE INDEX IF NOT EXISTS")) return { rows: [], rowCount: 0 };
      if (t.startsWith('INSERT INTO "_migrations"')) {
        const id = Number(values?.[0]);
        if (!state.ledger.includes(id)) state.ledger.push(id);
        return { rows: [], rowCount: 1 };
      }
      if (t === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (t.startsWith('SELECT MAX("id") AS v FROM "_migrations"')) {
        if (!state.tables.has("_migrations")) throw fail("42P01", 'relation "_migrations" does not exist');
        return { rows: [{ v: state.ledger.length ? Math.max(...state.ledger) : null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    release() {}
  }
  class FakePool {
    async query(text: string, values?: unknown[]) {
      return new FakeClient().query(text, values);
    }
    async connect() {
      return new FakeClient();
    }
  }
  return { state, reset, FakePool };
});

vi.mock("@neondatabase/serverless", () => ({ Pool: h.FakePool }));

import { PostgresStore } from "@/lib/store/postgres";

describe("Postgres migration on a brand-new database", () => {
  beforeEach(() => h.reset());

  it("creates the schema and ledger instead of aborting the transaction", async () => {
    const store = new PostgresStore("postgres://user@db.example/neondb");
    await store.migrate();
    expect(h.state.tables.has("_migrations")).toBe(true);
    expect(h.state.tables.has("referral_codes")).toBe(true);
    expect(h.state.ledger).toContain(1);
    await expect(store.health()).resolves.toMatchObject({
      reachable: true,
      ready: true,
      schemaVersion: 1,
    });
  });

  it("probes the ledger with to_regclass, never with a failing SELECT", async () => {
    const store = new PostgresStore("postgres://user@db.example/neondb");
    await store.migrate();
    expect(h.state.calls.some((c) => c.startsWith("SELECT to_regclass"))).toBe(true);
    expect(h.state.calls.find((c) => c.startsWith('SELECT "id" FROM "_migrations"'))).toBeUndefined();
  });

  it("is idempotent: a second cold start does not re-apply migration 1", async () => {
    await new PostgresStore("postgres://user@db.example/neondb").migrate();
    await new PostgresStore("postgres://user@db.example/neondb").migrate();
    expect(h.state.ledger.filter((id) => id === 1)).toHaveLength(1);
  });
});
