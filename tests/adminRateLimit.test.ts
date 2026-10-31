import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, setStore } from "@/lib/store";
import { ROUTE_LIMITS, enforceRateLimit } from "@/lib/server/apiGuard";

/**
 * Administrative endpoints must be rate limited *before* any expensive work and
 * must never grant access without a valid token.
 *
 * The heavy provider/telemetry modules are mocked so these tests exercise the
 * route wiring (limit → auth → work) without touching the network. The point of
 * the "rate limit runs first" assertions is that an unauthenticated brute-force
 * flood is throttled by the limiter itself, not merely rejected after it has
 * already probed every provider.
 */

const h = vi.hoisted(() => ({
  alchemyStatus: vi.fn(async () => ({ configured: false, reachable: false, at: 0 })),
  alchemyPricingStatus: vi.fn(async () => ({ configured: false, reachable: false, at: 0 })),
  zerionStatus: vi.fn(async () => ({ configured: false, reachable: false, at: 0 })),
  costSummary: vi.fn(async () => ({ today: {}, monthToDate: {}, byProvider: {} })),
  budgetState: vi.fn(async () => ({ budgetUsd: null, spentUsd: 0, fraction: null, threshold: "none", estimated: true })),
  buildForecast: vi.fn(async () => ({ measured: false, points: [] })),
  monthlyBudgetUsd: vi.fn(async () => null),
  setMonthlyBudgetUsd: vi.fn(async () => {}),
  recentOps: vi.fn(async () => ({ total: 0, unresolved: 0, bySeverity: {}, byCategory: {}, byService: {}, events: [] })),
  listAttempts: vi.fn(async () => []),
}));

vi.mock("@/lib/server/diagnostics", () => ({
  alchemyStatus: h.alchemyStatus,
  alchemyPricingStatus: h.alchemyPricingStatus,
  zerionStatus: h.zerionStatus,
}));
vi.mock("@/lib/server/cost", () => ({
  costSummary: h.costSummary,
  budgetState: h.budgetState,
  buildForecast: h.buildForecast,
  monthlyBudgetUsd: h.monthlyBudgetUsd,
  setMonthlyBudgetUsd: h.setMonthlyBudgetUsd,
}));
vi.mock("@/lib/server/ops", () => ({ recentOps: h.recentOps }));
vi.mock("@/lib/server/paymentAttempts", () => ({ listAttempts: h.listAttempts }));

import { GET as diagnosticsGet } from "@/app/api/diagnostics/route";
import { GET as costGet, POST as costPost } from "@/app/api/ops/cost/route";
import { GET as errorsGet } from "@/app/api/ops/errors/route";

const TOKEN = "test-admin-token-value";
const AUTH = { authorization: `Bearer ${TOKEN}` };

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin", { headers });
}

beforeEach(() => {
  setStore(new MemoryStore());
  process.env.INTENT_PAY_ADMIN_TOKEN = TOKEN;
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.INTENT_PAY_ADMIN_TOKEN;
});

describe("admin policy", () => {
  it("is bucket 'admin', limit 10, window 60s", () => {
    expect(ROUTE_LIMITS.admin).toEqual({ bucket: "admin", limit: 10, windowMs: 60_000 });
  });

  it("enforceRateLimit allows 10 then refuses the 11th with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await enforceRateLimit(req(), ROUTE_LIMITS.admin)).toBeNull();
    }
    const blocked = await enforceRateLimit(req(), ROUTE_LIMITS.admin);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("GET /api/diagnostics", () => {
  it("returns 401 without a token and never probes providers", async () => {
    const res = await diagnosticsGet(req());
    expect(res.status).toBe(401);
    expect(h.alchemyStatus).not.toHaveBeenCalled();
    expect(h.zerionStatus).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong token", async () => {
    const res = await diagnosticsGet(req({ authorization: "Bearer nope" }));
    expect(res.status).toBe(401);
    expect(h.alchemyStatus).not.toHaveBeenCalled();
  });

  it("returns 503 (not open) when the admin token is unset", async () => {
    delete process.env.INTENT_PAY_ADMIN_TOKEN;
    const res = await diagnosticsGet(req());
    expect(res.status).toBe(503);
  });

  it("serves an authorized request", async () => {
    const res = await diagnosticsGet(req(AUTH));
    expect(res.status).toBe(200);
    expect(h.alchemyStatus).toHaveBeenCalled();
  });

  it("throttles a flood: 10 allowed, the rest 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      statuses.push((await diagnosticsGet(req(AUTH))).status);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(3);
  });

  it("applies the limiter before auth: an unauthorized flood is throttled", async () => {
    // Every request is unauthenticated. The limiter still counts them, so after
    // 10 the route answers 429 rather than repeatedly evaluating credentials.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await diagnosticsGet(req())).status);
    }
    expect(statuses.filter((s) => s === 401).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
    // No provider probe ever ran.
    expect(h.alchemyStatus).not.toHaveBeenCalled();
  });
});

describe("GET/POST /api/ops/cost", () => {
  it("401 without a token, 200 with one", async () => {
    expect((await costGet(req())).status).toBe(401);
    expect((await costGet(req(AUTH))).status).toBe(200);
  });

  it("throttles the cost read", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await costGet(req(AUTH))).status);
    expect(statuses.filter((s) => s === 200).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });

  it("throttles the budget write too", async () => {
    const post = (body: unknown) =>
      costPost(
        new Request("http://localhost/api/ops/cost", {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post({ budgetUsd: 5 })).status);
    expect(statuses.filter((s) => s === 200).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });
});

describe("GET /api/ops/errors", () => {
  it("401 without a token, 200 with one", async () => {
    expect((await errorsGet(req())).status).toBe(401);
    expect((await errorsGet(req(AUTH))).status).toBe(200);
  });

  it("throttles the error view", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await errorsGet(req(AUTH))).status);
    expect(statuses.filter((s) => s === 200).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });
});
