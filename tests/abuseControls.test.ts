import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, setStore } from "@/lib/store";
import { rateLimit, clientIp, clientFingerprint } from "@/lib/server/rateLimit";
import { readJsonBody, capArray, MAX_JSON_BODY_BYTES } from "@/lib/server/apiGuard";

/**
 * Abuse controls. These lock the behaviour that makes the limiter a real control
 * rather than a decorative one:
 *   - a fixed window counts and then refuses;
 *   - the client IP is taken from a *trusted* header, never the client-controlled
 *     first hop of X-Forwarded-For;
 *   - a store failure fails open (never blocks a legitimate payment).
 */
describe("rate limiter", () => {
  beforeEach(() => setStore(new MemoryStore()));
  afterEach(() => setStore(null));

  it("allows up to the limit then refuses within the window", async () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = await rateLimit({ bucket: "t", subject: "ip", limit: 3, windowMs: 60_000, now });
      expect(r.ok).toBe(true);
    }
    const over = await rateLimit({ bucket: "t", subject: "ip", limit: 3, windowMs: 60_000, now });
    expect(over.ok).toBe(false);
    expect(over.resetAt).toBeGreaterThan(now);
  });

  it("resets in the next window", async () => {
    const base = 1_000_000;
    await rateLimit({ bucket: "t", subject: "ip", limit: 1, windowMs: 60_000, now: base });
    const blocked = await rateLimit({ bucket: "t", subject: "ip", limit: 1, windowMs: 60_000, now: base });
    expect(blocked.ok).toBe(false);
    const next = await rateLimit({ bucket: "t", subject: "ip", limit: 1, windowMs: 60_000, now: base + 60_000 });
    expect(next.ok).toBe(true);
  });

  it("counts a concurrent burst exactly (no lost increment)", async () => {
    // A read-modify-write limiter lets N simultaneous requests all read the same
    // count and all pass, so a burst slips past the limit. The atomic increment
    // must admit exactly `limit` of them.
    const now = 5_000_000;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        rateLimit({ bucket: "burst", subject: "ip", limit: 10, windowMs: 60_000, now }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(40);
  });

  it("fails open when the store is unreachable", async () => {
    setStore({
      findOne: async () => {
        throw new Error("db down");
      },
    } as unknown as MemoryStore);
    const r = await rateLimit({ bucket: "t", subject: "ip", limit: 1, windowMs: 60_000 });
    expect(r.ok).toBe(true);
  });
});

describe("trusted client IP", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("http://x/api/nlp", { headers });
  }

  it("never trusts the client-controlled first hop of X-Forwarded-For", () => {
    // An attacker prepends a spoofed value; the trusted edge appends the real one.
    const ip = clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    expect(ip).toBe("203.0.113.9");
  });

  it("prefers x-real-ip when present", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" }))).toBe("198.51.100.7");
  });

  it("falls back to a single shared bucket when nothing is present", () => {
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("produces a stable fingerprint for the same client and rotates daily", () => {
    const a = clientFingerprint(req({ "x-real-ip": "198.51.100.7", "user-agent": "ua" }), 1_000_000);
    const b = clientFingerprint(req({ "x-real-ip": "198.51.100.7", "user-agent": "ua" }), 1_000_000 + 1000);
    expect(a).toBe(b);
  });
});

describe("readJsonBody", () => {
  function jsonReq(body: string, contentLength?: number): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    return new Request("http://x/api/nlp", { method: "POST", headers, body });
  }

  it("parses a small body", async () => {
    const r = await readJsonBody<{ a: number }>(jsonReq(JSON.stringify({ a: 1 })));
    expect(r.ok && r.body.a).toBe(1);
  });

  it("rejects a body larger than the cap", async () => {
    const big = JSON.stringify({ x: "y".repeat(MAX_JSON_BODY_BYTES) });
    const r = await readJsonBody(jsonReq(big));
    expect(r.ok).toBe(false);
  });

  it("rejects an over-cap declared Content-Length without reading", async () => {
    const r = await readJsonBody(jsonReq("{}", MAX_JSON_BODY_BYTES + 1));
    expect(r.ok).toBe(false);
  });

  it("rejects malformed JSON", async () => {
    expect((await readJsonBody(jsonReq("{not json"))).ok).toBe(false);
  });
});

describe("capArray", () => {
  it("bounds an untrusted array", () => {
    expect(capArray([1, 2, 3, 4, 5], 2)).toEqual([1, 2]);
  });
  it("returns [] for a non-array", () => {
    expect(capArray("nope", 5)).toEqual([]);
  });
});
