import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, setStore } from "@/lib/store";
import {
  challengeMessage,
  createChallenge,
  issueSession,
  verifySession,
  verifyChallenge,
  adminAuthorized,
} from "@/lib/server/auth";
import {
  getOrCreateCode,
  recordClick,
  attribute,
  referralForReferred,
  qualify,
  dashboardFor,
} from "@/lib/server/referral";
import { createAttempt, getAttempt, updateAttempt, recordFailure } from "@/lib/server/paymentAttempts";
import { recordOpsEvent, recentOps } from "@/lib/server/ops";
import {
  recordUsage,
  costSummary,
  setMonthlyBudgetUsd,
  checkBudgetAlert,
  estimateCostUsd,
  utcDay,
} from "@/lib/server/cost";
import { classifyCode } from "@/lib/domain/failureTaxonomy";
import type { Verifier } from "@/lib/server/referral/verify";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";

beforeEach(() => {
  setStore(new MemoryStore());
});

describe("wallet-signed session", () => {
  it("issues a token that verifies and is bound to the address", async () => {
    const token = await issueSession(ALICE);
    const session = await verifySession(token);
    expect(session?.address).toBe(ALICE.toLowerCase());
  });

  it("rejects a tampered token", async () => {
    const token = await issueSession(ALICE);
    const [payload] = token.split(".");
    expect(await verifySession(`${payload}.deadbeef`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Date.now();
    const token = await issueSession(ALICE, now);
    expect(await verifySession(token, now + 25 * 60 * 60 * 1000)).toBeNull();
  });

  it("accepts a valid signature and burns the nonce (single use)", async () => {
    const { nonce, message } = await createChallenge(ALICE);
    const recover = () => ALICE;
    const first = await verifyChallenge({ address: ALICE, nonce, message, signature: "0xsig", recover });
    expect(first.ok).toBe(true);
    const replay = await verifyChallenge({ address: ALICE, nonce, message, signature: "0xsig", recover });
    expect(replay.ok).toBe(false);
  });

  it("rejects a signature that recovers a different address", async () => {
    const { nonce, message } = await createChallenge(ALICE);
    const res = await verifyChallenge({ address: ALICE, nonce, message, signature: "0xsig", recover: () => BOB });
    expect(res.ok).toBe(false);
  });

  it("builds a message that names the address and chain", () => {
    const msg = challengeMessage(ALICE, "n1", "intent-pay");
    expect(msg).toContain(ALICE.toLowerCase());
    expect(msg).toContain("143");
    expect(msg).toContain("n1");
  });

  it("admin authorization requires the configured token", () => {
    expect(adminAuthorized(null)).toBe(false);
    expect(adminAuthorized("Bearer wrong")).toBe(false);
  });
});

describe("referral lifecycle", () => {
  it("creates a stable code for a wallet and reuses it", async () => {
    const a = await getOrCreateCode(ALICE);
    const b = await getOrCreateCode(ALICE);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.value).toBe(b.value);
  });

  it("attributes a wallet once; a later code cannot overwrite (first touch wins)", async () => {
    const aliceCode = await getOrCreateCode(ALICE);
    const bobCode = await getOrCreateCode(BOB);
    if (!aliceCode.ok || !bobCode.ok) throw new Error("codes");
    const first = await attribute({ code: aliceCode.value, referred: CAROL });
    expect(first.ok).toBe(true);
    const second = await attribute({ code: bobCode.value, referred: CAROL });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_attributed");
    expect((await referralForReferred(CAROL))?.referrer).toBe(ALICE.toLowerCase());
  });

  it("refuses self-referral", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    const res = await attribute({ code: code.value, referred: ALICE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("self_referral");
  });

  it("deduplicates clicks per code+fingerprint+day", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    const now = Date.now();
    const a = await recordClick({ code: code.value, fingerprint: "fp", now });
    const b = await recordClick({ code: code.value, fingerprint: "fp", now });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value.deduped).toBe(true);
  });

  it("qualifies only from a verified on-chain payment", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    await attribute({ code: code.value, referred: CAROL });
    const verifier = (async () => ({
      ok: true as const,
      evidence: { chainId: 143, from: CAROL, to: BOB, blockNumber: 1, transferLogs: 1 },
    })) as unknown as Verifier;
    const res = await qualify({ referred: CAROL, txHash: "0x" + "a".repeat(64), verifier });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.state).toBe("qualified");
  });

  it("rejects a qualification when the verifier cannot confirm the tx", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    await attribute({ code: code.value, referred: CAROL });
    const verifier = (async () => ({
      ok: false as const,
      reason: "reverted" as const,
      message: "reverted",
    })) as unknown as Verifier;
    const res = await qualify({ referred: CAROL, txHash: "0x" + "b".repeat(64), verifier });
    expect(res.ok).toBe(false);
  });

  it("never counts a click as a qualified referral", async () => {
    const code = await getOrCreateCode(ALICE);
    if (!code.ok) throw new Error("code");
    await recordClick({ code: code.value, fingerprint: "fp2" });
    const dash = await dashboardFor(ALICE, (c) => `https://x/?ref=${c}`);
    expect(dash.ok).toBe(true);
    if (dash.ok) {
      expect(dash.value.counts.qualified).toBe(0);
      expect(dash.value.counts.clicks).toBe(1);
    }
  });
});

describe("payment attempt correlation", () => {
  it("creates, advances and records failure with a taxonomy category", async () => {
    const attempt = await createAttempt({ account: ALICE, intentKey: "key1", gasMode: "erc20" });
    expect(attempt.status).toBe("created");
    await updateAttempt(attempt.id, { status: "submitted", txHash: "0x" + "c".repeat(64) });
    const failed = await recordFailure(attempt.id, "route_unavailable", "quote");
    expect(failed.category).toBe(classifyCode("route_unavailable", "quote").category);
    expect(failed.mayHaveSubmitted).toBe(false);
    expect((await getAttempt(attempt.id))?.status).toBe("failed");
  });

  it("treats a submitted-stage failure as possibly on-chain", async () => {
    const attempt = await createAttempt({ account: ALICE, intentKey: "key2" });
    await updateAttempt(attempt.id, { status: "submitted" });
    const failed = await recordFailure(attempt.id, "submitted", "execution");
    expect(failed.mayHaveSubmitted).toBe(true);
  });

  it("redacts secrets from a stored diagnostic", async () => {
    const attempt = await createAttempt({ account: ALICE, intentKey: "key3", diagnostic: "key=sk-live-abc123" });
    expect(attempt.diagnostic).not.toContain("sk-live-abc123");
  });

  it("reuses one attempt for a repeated idempotency key (retry never duplicates)", async () => {
    const first = await createAttempt({ account: ALICE, intentKey: "key4", idempotencyKey: "alice:3|mainnet|..." });
    const second = await createAttempt({ account: ALICE, intentKey: "key4", idempotencyKey: "alice:3|mainnet|..." });
    expect(second.id).toBe(first.id);
  });

  it("creates distinct attempts when no idempotency key is supplied", async () => {
    const a = await createAttempt({ account: ALICE, intentKey: "key5" });
    const b = await createAttempt({ account: ALICE, intentKey: "key5" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("ops events", () => {
  it("records an event and reports it in the recent window", async () => {
    await recordOpsEvent({ category: "provider_error", service: "api/nlp", message: "boom", severity: "error" });
    const summary = await recentOps(60_000);
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.events.some((e) => e.service === "api/nlp")).toBe(true);
  });

  it("marks error/critical events unresolved by default", async () => {
    const e = await recordOpsEvent({ category: "unknown_error", service: "x", severity: "critical" });
    expect(e.unresolved).toBe(true);
  });
});

describe("cost accounting", () => {
  it("estimates cost from a price table", () => {
    const cost = estimateCostUsd("gpt-4o-mini", 1000, 1000);
    expect(cost).toBeGreaterThan(0);
  });

  it("rolls usage into the daily summary", async () => {
    await recordUsage({ provider: "intent-llm", kind: "intent_extract", model: "gpt-4o-mini", inputTokens: 500, outputTokens: 100 });
    const summary = await costSummary();
    expect(summary.today.requests).toBeGreaterThan(0);
    expect(Number(summary.today.estimatedCostUsd)).toBeGreaterThan(0);
  });

  it("raises a threshold alert once the budget is crossed", async () => {
    // A budget inside the warn/high/critical band (not yet 'over', which is
    // reported as state rather than as a threshold alert).
    await setMonthlyBudgetUsd(0.08);
    await recordUsage({ provider: "intent-llm", kind: "intent_extract", model: "gpt-4o", inputTokens: 5000, outputTokens: 5000 });
    const alert = await checkBudgetAlert();
    expect(alert).not.toBeNull();
    // Deduplicated: the same threshold is not announced twice the same day.
    expect(await checkBudgetAlert()).toBeNull();
  });

  it("uses a UTC day key", () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02");
  });
});
