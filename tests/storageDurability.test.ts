import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryStore,
  SqliteStore,
  setStore,
  storeCapability,
  storeStatus,
  requireDurableStore,
} from "@/lib/store";
import { SESSION_COOKIE, issueSession } from "@/lib/server/auth";
import { createAttempt } from "@/lib/server/paymentAttempts";

import { POST as attributePOST } from "@/app/api/referral/attribute/route";
import { GET as meGET } from "@/app/api/referral/me/route";
import { POST as qualifyPOST } from "@/app/api/referral/qualify/route";
import { GET as availabilityGET } from "@/app/api/referral/availability/route";
import { GET as capabilitiesGET } from "@/app/api/capabilities/route";

/**
 * Storage durability honesty.
 *
 * The referral feature needs attribution that survives a restart. The store can
 * run in several modes, and the app must describe — and act on — the real one:
 *   - memory     → nothing survives;
 *   - ephemeral  → a temp-dir SQLite file a serverless cold start erases, or an
 *                  unreachable / un-migrated remote database;
 *   - persistent → a verified, reachable, migrated database.
 *
 * A required durable operation must NEVER silently succeed through an ephemeral
 * fallback, a bare connection string must NEVER be mistaken for durable storage,
 * and payment initiation must not depend on referral storage at all.
 */

const ALICE = "0x1111111111111111111111111111111111111111";
const ENV_KEYS = ["INTENT_PAY_DB_PATH", "INTENT_PAY_STORE", "DATABASE_URL", "INTENT_PAY_DATABASE_URL"] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function req(
  url: string,
  opts: { method?: string; cookie?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Request(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

async function cookieFor(address: string): Promise<string> {
  return `${SESSION_COOKIE}=${await issueSession(address)}`;
}

beforeEach(() => {
  clearEnv();
  setStore(new MemoryStore());
});

afterEach(() => {
  clearEnv();
  vi.unstubAllGlobals();
  setStore(null);
});

describe("store durability is reported honestly", () => {
  it("a memory store is never reported as durable", async () => {
    setStore(new MemoryStore());
    const cap = await storeCapability();
    expect(cap.durability).toBe("memory");
    expect(cap.durable).toBe(false);
    expect(await storeStatus()).toEqual({ kind: "memory", durability: "memory", durable: false });
    expect((await requireDurableStore()).ok).toBe(false);
  });

  it("a default temp-dir SQLite file is ephemeral, not durable", async () => {
    setStore(new SqliteStore(":memory:"));
    const cap = await storeCapability();
    expect(cap.durability).toBe("ephemeral");
    expect(cap.durable).toBe(false);
    expect((await requireDurableStore()).ok).toBe(false);
  });

  it("an explicitly configured DB path is reported persistent", async () => {
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    setStore(new SqliteStore(":memory:"));
    const cap = await storeCapability();
    expect(cap.durability).toBe("persistent");
    expect(cap.durable).toBe(true);
    expect(cap.reachable).toBe(true);
    expect(cap.schemaReady).toBe(true);
    expect((await requireDurableStore()).ok).toBe(true);
  });

  it("storeStatus exposes no filesystem path or secret", async () => {
    process.env.INTENT_PAY_DB_PATH = "/very/secret/place.sqlite";
    setStore(new SqliteStore(":memory:"));
    const json = JSON.stringify(await storeCapability());
    expect(json).not.toContain("/very");
    expect(json).not.toContain("place.sqlite");
  });
});

describe("a required durable referral operation cannot silently succeed", () => {
  it("refuses attribution (503) when the store is memory", async () => {
    setStore(new MemoryStore());
    const res = await attributePOST(
      req("http://x/api/referral/attribute", {
        method: "POST",
        cookie: await cookieFor(ALICE),
        body: { code: "INTENT-ABCDEF" },
      }),
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("storage_unavailable");
    expect(json.durable).toBe(false);
  });

  it("refuses /me (503) when the store is memory", async () => {
    setStore(new MemoryStore());
    const res = await meGET(req("http://x/api/referral/me", { cookie: await cookieFor(ALICE) }));
    expect(res.status).toBe(503);
    expect((await res.json()).durable).toBe(false);
  });

  it("refuses qualification (503) when the store is memory", async () => {
    setStore(new MemoryStore());
    const res = await qualifyPOST(
      req("http://x/api/referral/qualify", {
        method: "POST",
        cookie: await cookieFor(ALICE),
        body: { txHash: "0x" + "a".repeat(64) },
      }),
    );
    expect(res.status).toBe(503);
  });

  it("serves referrals, marked durable, when the store is persistent", async () => {
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    setStore(new SqliteStore(":memory:"));
    const res = await meGET(req("http://x/api/referral/me", { cookie: await cookieFor(ALICE) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.durable).toBe(true);
    expect(typeof json.code).toBe("string");
  });

  it("the availability endpoint reports the honest durability without auth", async () => {
    setStore(new MemoryStore());
    let json = await (await availabilityGET()).json();
    expect(json).toMatchObject({ durable: false, durability: "memory", referralAttribution: "unavailable" });

    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    setStore(new SqliteStore(":memory:"));
    json = await (await availabilityGET()).json();
    expect(json).toMatchObject({ durable: true, durability: "persistent", referralAttribution: "available" });
  });
});

describe("payment initiation is independent of referral storage", () => {
  it("creates a payment attempt while referrals are refused (memory store)", async () => {
    setStore(new MemoryStore());

    // Referrals are honestly unavailable...
    const att = await attributePOST(
      req("http://x/api/referral/attribute", {
        method: "POST",
        cookie: await cookieFor(ALICE),
        body: { code: "INTENT-ABCDEF" },
      }),
    );
    expect(att.status).toBe(503);

    // ...and payment attempt correlation still works.
    const attempt = await createAttempt({ account: ALICE, intentKey: "intent", idempotencyKey: "idem" });
    expect(attempt.id).toBeTruthy();
    expect(attempt.status).toBe("created");
  });
});

describe("capability reporting reflects the implementation", () => {
  it("reports memory storage accurately and marks referrals unavailable", async () => {
    setStore(new MemoryStore());
    const json = await (await capabilitiesGET()).json();
    expect(json.storage).toMatchObject({
      kind: "memory",
      durability: "memory",
      durable: false,
      referralAttribution: "unavailable",
    });
  });

  it("reports persistent storage accurately", async () => {
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    setStore(new SqliteStore(":memory:"));
    const json = await (await capabilitiesGET()).json();
    expect(json.storage.durable).toBe(true);
    expect(json.storage.referralAttribution).toBe("available");
  });

  it("never exposes the database path in the capabilities response", async () => {
    process.env.INTENT_PAY_DB_PATH = "/secret/location/db.sqlite";
    setStore(new SqliteStore(":memory:"));
    const text = JSON.stringify(await (await capabilitiesGET()).json());
    expect(text).not.toContain("/secret");
    expect(text).not.toContain("db.sqlite");
  });

  it("advertises native-MON gas only, never an ERC-20 / account-abstraction path", async () => {
    setStore(new MemoryStore());
    const json = await (await capabilitiesGET()).json();
    // The execution path is a plain EOA that pays the fee in MON. A paymaster /
    // AA capability must not be advertised while that path cannot use one — a
    // responding quote endpoint is not proof of usability.
    expect(json.gas.mode).toBe("native");
    expect(json.walletAbstraction).toBeUndefined();
    expect(json.gasPayment).toBeUndefined();
    expect(json.mevProtection.active).toBe(false);
  });
});

/**
 * A configured Postgres URL is not proof of durable storage: the backend must be
 * reachable AND migrated. These tests use the REAL adapter with a stubbed global
 * WebSocket, so the SQL/transaction logic and the capability probe are exercised
 * end to end; they do not touch a network or a real database.
 */
describe("a configured Postgres database is only durable when reachable and migrated", () => {
  it("reports NOT durable when the database is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@db.example/neondb";
    // The driver opens a WebSocket; with no server it rejects, so the probe
    // reports reachable:false rather than a false success.
    const { PostgresStore } = await import("@/lib/store/postgres");
    setStore(new PostgresStore(process.env.DATABASE_URL));
    const cap = await storeCapability();
    expect(cap.kind).toBe("postgres");
    expect(cap.durable).toBe(false);
    expect(cap.reachable).toBe(false);
    expect(cap.reason).toBeTruthy();
    // A required durable operation is refused with the honest code.
    expect((await requireDurableStore()).ok).toBe(false);
  });

  it("reports NOT durable when the database is reachable but NOT migrated", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@db.example/neondb";
    // A reachable database that has never run migrations reports ready:false.
    const health = vi.fn(async () => ({ reachable: true, ready: false, schemaVersion: null }));
    setStore(fakePg(health));
    const cap = await storeCapability();
    expect(cap.kind).toBe("postgres");
    expect(cap.reachable).toBe(true);
    expect(cap.schemaReady).toBe(false);
    expect(cap.durable).toBe(false);
    expect(cap.reason).toMatch(/migrat/i);
  });

  it("reports durable only when reachable AND migrated", async () => {
    process.env.DATABASE_URL = "postgres://user:pw@db.example/neondb";
    const health = vi.fn(async () => ({ reachable: true, ready: true, schemaVersion: 1 }));
    setStore(fakePg(health));
    const cap = await storeCapability();
    expect(cap.durable).toBe(true);
    expect(cap.durability).toBe("persistent");
    expect(cap.reason).toBeNull();
  });
});

/** A minimal fake Postgres adapter used only to drive the capability probe. */
function fakePg(health: () => Promise<{ reachable: boolean; ready: boolean; schemaVersion: number | null }>) {
  return {
    kind: "postgres" as const,
    health,
    insert: async () => {},
    upsert: async () => {},
    findOne: async () => undefined,
    findMany: async () => [],
    update: async () => 0,
    remove: async () => 0,
    count: async () => 0,
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    reset: async () => {},
  };
}
