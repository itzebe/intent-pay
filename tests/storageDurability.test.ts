import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  SqliteStore,
  setStore,
  storeDurability,
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
 * run in three modes, and the app must describe — and act on — the real one:
 *   - memory     → nothing survives;
 *   - ephemeral  → a temp-dir SQLite file a serverless cold start erases;
 *   - persistent → an explicitly configured DB path.
 *
 * A required durable operation must NEVER silently succeed through an ephemeral
 * fallback, and payment initiation must not depend on referral storage at all.
 */

const ALICE = "0x1111111111111111111111111111111111111111";
const ENV_KEYS = ["INTENT_PAY_DB_PATH", "INTENT_PAY_STORE"] as const;

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

function cookieFor(address: string): string {
  return `${SESSION_COOKIE}=${issueSession(address)}`;
}

beforeEach(() => {
  clearEnv();
  setStore(new MemoryStore());
});

afterEach(() => {
  clearEnv();
  setStore(null);
});

describe("store durability is reported honestly", () => {
  it("a memory store is never reported as durable", () => {
    setStore(new MemoryStore());
    expect(storeDurability()).toBe("memory");
    expect(storeStatus()).toEqual({ kind: "memory", durability: "memory", durable: false });
    expect(requireDurableStore().ok).toBe(false);
  });

  it("a default temp-dir SQLite file is ephemeral, not durable", () => {
    setStore(new SqliteStore(":memory:"));
    expect(storeDurability()).toBe("ephemeral");
    expect(storeStatus().durable).toBe(false);
    expect(requireDurableStore().ok).toBe(false);
  });

  it("an explicitly configured DB path is reported persistent", () => {
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    setStore(new SqliteStore(":memory:"));
    expect(storeDurability()).toBe("persistent");
    expect(storeStatus().durable).toBe(true);
    expect(requireDurableStore().ok).toBe(true);
  });

  it("storeStatus exposes no filesystem path or secret", () => {
    process.env.INTENT_PAY_DB_PATH = "/very/secret/place.sqlite";
    setStore(new SqliteStore(":memory:"));
    const json = JSON.stringify(storeStatus());
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
        cookie: cookieFor(ALICE),
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
    const res = await meGET(req("http://x/api/referral/me", { cookie: cookieFor(ALICE) }));
    expect(res.status).toBe(503);
    expect((await res.json()).durable).toBe(false);
  });

  it("refuses qualification (503) when the store is memory", async () => {
    setStore(new MemoryStore());
    const res = await qualifyPOST(
      req("http://x/api/referral/qualify", {
        method: "POST",
        cookie: cookieFor(ALICE),
        body: { txHash: "0x" + "a".repeat(64) },
      }),
    );
    expect(res.status).toBe(503);
  });

  it("serves referrals, marked durable, when the store is persistent", async () => {
    process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
    setStore(new SqliteStore(":memory:"));
    const res = await meGET(req("http://x/api/referral/me", { cookie: cookieFor(ALICE) }));
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
        cookie: cookieFor(ALICE),
        body: { code: "INTENT-ABCDEF" },
      }),
    );
    expect(att.status).toBe(503);

    // ...and payment attempt correlation still works.
    const attempt = createAttempt({ account: ALICE, intentKey: "intent", idempotencyKey: "idem" });
    expect(attempt.id).toBeTruthy();
    expect(attempt.status).toBe("created");
  });
});

describe("capability reporting reflects the implementation", () => {
  it("reports memory storage accurately and marks referrals unavailable", async () => {
    setStore(new MemoryStore());
    const json = await (await capabilitiesGET()).json();
    expect(json.storage).toEqual({
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
});
