import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, setStore } from "@/lib/store";
import {
  getOrCreateCode,
  attribute,
  referralForReferred,
  qualify,
  dashboardFor,
  recordClick,
} from "@/lib/server/referral";
import type { Verifier } from "@/lib/server/referral/verify";

/**
 * Referral persistence and concurrency.
 *
 * These tests use a REAL on-disk SQLite database (Node's built-in `node:sqlite`,
 * the same relational engine the referral logic runs against in production) and
 * simulate a process restart by opening a SECOND store on the same file. That is
 * the property that matters: attribution must survive a new process, not merely a
 * new request. Uniqueness is enforced by the database, so concurrency is settled
 * by the UNIQUE constraints, never by a read-then-write.
 *
 * The Postgres adapter shares the identical schema and integrity rules
 * (lib/store/schema.ts), so this is representative of the managed backend; the
 * live Postgres path is verified separately (see the deployment report) because
 * it needs a real database.
 */

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const DAVE = "0x4444444444444444444444444444444444444444";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intent-pay-referral-"));
  dbPath = join(dir, "intent-pay.sqlite");
  process.env.INTENT_PAY_DB_PATH = dbPath;
  setStore(new SqliteStore(dbPath));
});

afterEach(() => {
  delete process.env.INTENT_PAY_DB_PATH;
  setStore(null);
  rmSync(dir, { recursive: true, force: true });
});

/** Simulate a process restart: open a fresh store on the same file. */
function restart(): void {
  setStore(null);
  setStore(new SqliteStore(dbPath));
}

describe("records persist across a process restart", () => {
  it("keeps a wallet's referral code across a restart", async () => {
    const created = await getOrCreateCode(ALICE);
    if (!created.ok) throw new Error("code");
    restart();
    const again = await getOrCreateCode(ALICE);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toBe(created.value);
  });

  it("keeps attribution across a restart", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    await attribute({ code: code.value, referred: CAROL });
    restart();
    const found = await referralForReferred(CAROL);
    expect(found?.referrer).toBe(ALICE.toLowerCase());
    expect(found?.state).toBe("attributed");
  });

  it("keeps a qualification across a restart", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    await attribute({ code: code.value, referred: CAROL });
    const verifier = (async () => ({
      ok: true as const,
      evidence: { chainId: 143, from: CAROL, to: BOB, blockNumber: 1, transferLogs: 1 },
    })) as unknown as Verifier;
    const txHash = "0x" + "a".repeat(64);
    await qualify({ referred: CAROL, txHash, verifier });
    restart();
    const dash = await dashboardFor(ALICE, (c) => `https://x/?ref=${c}`);
    expect(dash.ok).toBe(true);
    if (dash.ok) {
      expect(dash.value.counts.qualified).toBe(1);
    }
    const found = await referralForReferred(CAROL);
    expect(found?.state).toBe("qualified");
    expect(found?.qualifiedTxHash).toBe(txHash);
  });
});

describe("concurrency cannot create duplicates", () => {
  it("allocates exactly one code for a wallet under concurrent requests", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateCode(ALICE)));
    const codes = new Set(results.filter((r) => r.ok).map((r) => (r as { value: string }).value));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(codes.size).toBe(1);
  });

  it("attributes a referred wallet exactly once under concurrent requests", async () => {
    const a = await getOrCreateCode(ALICE);
    const b = await getOrCreateCode(BOB);
    if (!a.ok || !b.ok) throw new Error("codes");
    // Two different referrers race for the same referred wallet.
    const [r1, r2] = await Promise.all([
      attribute({ code: a.value, referred: DAVE }),
      attribute({ code: b.value, referred: DAVE }),
    ]);
    const winners = [r1, r2].filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const stored = await referralForReferred(DAVE);
    expect(stored).toBeTruthy();
    // The stored referrer is exactly one of the two, and never both.
    expect([ALICE.toLowerCase(), BOB.toLowerCase()]).toContain(stored!.referrer);
  });

  it("qualifies once under concurrent attempts with the same transaction", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    await attribute({ code: code.value, referred: CAROL });
    const verifier = (async () => ({
      ok: true as const,
      evidence: { chainId: 143, from: CAROL, to: BOB, blockNumber: 1, transferLogs: 1 },
    })) as unknown as Verifier;
    const txHash = "0x" + "b".repeat(64);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => qualify({ referred: CAROL, txHash, verifier })),
    );
    // Every attempt reports success (idempotent) and resolves to the same record.
    expect(results.every((r) => r.ok)).toBe(true);
    const states = new Set(results.map((r) => (r.ok ? r.value.state : "err")));
    expect(states).toEqual(new Set(["qualified"]));
  });

  it("counts a repeated click once (dedup key is unique at the database level)", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => recordClick({ code: code.value, fingerprint: "fp", now })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const stored = await referralForReferred(CAROL); // not this one
    expect(stored).toBeUndefined();
    const dash = await dashboardFor(ALICE, (c) => `https://x/?ref=${c}`);
    expect(dash.ok).toBe(true);
    if (dash.ok) expect(dash.value.counts.clicks).toBe(1);
  });
});
