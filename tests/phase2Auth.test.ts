import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, setStore } from "@/lib/store";
import { SESSION_COOKIE, issueSession } from "@/lib/server/auth";
import { createAttempt } from "@/lib/server/paymentAttempts";

import { GET as sessionGET } from "@/app/api/auth/session/route";
import { GET as meGET } from "@/app/api/referral/me/route";
import { POST as qualifyPOST } from "@/app/api/referral/qualify/route";
import { POST as attemptStatusPOST } from "@/app/api/payments/attempts/status/route";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}): Request {
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
  setStore(new MemoryStore());
});

describe("session route", () => {
  it("reports unauthenticated without a cookie", async () => {
    const res = await sessionGET(req("http://x/api/auth/session"));
    const json = await res.json();
    expect(json.authenticated).toBe(false);
  });

  it("reports the address for a valid session", async () => {
    const res = await sessionGET(req("http://x/api/auth/session", { cookie: cookieFor(ALICE) }));
    const json = await res.json();
    expect(json.authenticated).toBe(true);
    expect(json.address).toBe(ALICE.toLowerCase());
  });
});

describe("referral authorization", () => {
  it("GET /api/referral/me is 401 without a session", async () => {
    const res = await meGET(req("http://x/api/referral/me"));
    expect(res.status).toBe(401);
  });

  it("GET /api/referral/me returns only the caller's own dashboard", async () => {
    const alice = await meGET(req("http://x/api/referral/me", { cookie: cookieFor(ALICE) }));
    const bob = await meGET(req("http://x/api/referral/me", { cookie: cookieFor(BOB) }));
    const a = await alice.json();
    const b = await bob.json();
    expect(a.ok && b.ok).toBe(true);
    expect(a.code).not.toBe(b.code);
    // There is no address parameter to tamper with — identity is the cookie.
    expect(a.address).toBe(ALICE.toLowerCase());
    expect(b.address).toBe(BOB.toLowerCase());
  });

  it("POST /api/referral/qualify is 401 without a session", async () => {
    const res = await qualifyPOST(
      req("http://x/api/referral/qualify", { method: "POST", body: { txHash: "0x" + "a".repeat(64) } }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/referral/qualify rejects a malformed hash for a signed-in wallet", async () => {
    const res = await qualifyPOST(
      req("http://x/api/referral/qualify", { method: "POST", cookie: cookieFor(ALICE), body: { txHash: "nope" } }),
    );
    expect(res.status).toBe(400);
  });
});

describe("payment attempt isolation", () => {
  it("forbids a different wallet from advancing another wallet's attempt", async () => {
    const attempt = createAttempt({ account: ALICE, intentKey: "k" });
    const res = await attemptStatusPOST(
      req("http://x/api/payments/attempts/status", {
        method: "POST",
        cookie: cookieFor(BOB),
        body: { id: attempt.id, event: "submitted" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows the owning wallet to advance its own attempt", async () => {
    const attempt = createAttempt({ account: ALICE, intentKey: "k" });
    const res = await attemptStatusPOST(
      req("http://x/api/payments/attempts/status", {
        method: "POST",
        cookie: cookieFor(ALICE),
        body: { id: attempt.id, event: "submitted", txHash: "0x" + "b".repeat(64) },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status).toBe("submitted");
  });

  it("rejects an unknown attempt id", async () => {
    const res = await attemptStatusPOST(
      req("http://x/api/payments/attempts/status", {
        method: "POST",
        cookie: cookieFor(ALICE),
        body: { id: "does-not-exist", event: "submitted" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
