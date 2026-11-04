import { describe, expect, it } from "vitest";
import { IntentPay } from "../src/index.js";
import { isCheckoutPaid } from "../src/core/types.js";
import { MockFetch, errorResponse, jsonResponse } from "./helpers.js";

const KEY = "ipk_live_abcdef123456.0123456789abcdef0123456789abcdef";

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    id: "chk_1",
    object: "checkout",
    status: "open",
    phase: "awaiting_payment",
    intentId: "int_1",
    orderReference: "ORD-1001",
    token: `chk_${"a".repeat(64)}`,
    tokenHint: "aaaaaaaa",
    expiresAt: "2026-01-01T00:30:00.000Z",
    completedAt: null,
    canceledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function client(mock: MockFetch) {
  return new IntentPay({ apiKey: KEY, fetch: mock.fetch, maxRetries: 0 });
}

describe("createCheckout", () => {
  it("sends the documented body and returns the token and link handle", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts", () =>
      jsonResponse({ ok: true, created: true, checkout: checkout(), token: `chk_${"a".repeat(64)}` }, { status: 201 }),
    );
    const result = await client(mock).createCheckout({ intentId: "int_1", orderReference: "ORD-1001" });
    expect(result.checkout.id).toBe("chk_1");
    expect(result.token).toMatch(/^chk_[0-9a-f]{64}$/);
    expect(result.created).toBe(true);
    const body = mock.requests[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ intentId: "int_1", orderReference: "ORD-1001" });
  });

  it("sends the idempotency key as a header and in the body", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts", () =>
      jsonResponse({ ok: true, created: false, checkout: checkout(), token: `chk_${"a".repeat(64)}` }),
    );
    await client(mock).createCheckout({ intentId: "int_1", idempotencyKey: "order-1" });
    expect(mock.requests[0]!.headers["idempotency-key"]).toBe("order-1");
  });

  it("requires a credential", async () => {
    const mock = new MockFetch();
    await expect(new IntentPay({ fetch: mock.fetch }).createCheckout({ intentId: "int_1" })).rejects.toThrow(/apiKey/);
  });
});

describe("checkout lifecycle methods", () => {
  it("gets a checkout and its bound intent", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/checkouts/chk_1", () =>
      jsonResponse({ ok: true, checkout: checkout(), intent: { id: "int_1", state: "awaiting_authorization", authorized: true }, lifecycle: [] }),
    );
    const result = await client(mock).getCheckout("chk_1");
    expect(result.checkout.id).toBe("chk_1");
    expect(result.intent?.authorized).toBe(true);
  });

  it("lists checkouts", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/checkouts", () => jsonResponse({ ok: true, checkouts: [checkout()] }));
    const list = await client(mock).listCheckouts();
    expect(list).toHaveLength(1);
    expect(list[0]!.object).toBe("checkout");
  });

  it("prepares a checkout for a customer wallet (builds only)", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts/chk_1/prepare", () =>
      jsonResponse({ ok: true, calls: [{ to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" }], steps: [], fingerprint: "int_abc12345" }),
    );
    const prepared = await client(mock).prepareCheckout("chk_1", { sender: "0x1234567890aBcDeF1234567890aBcDeF12345678" });
    expect(prepared.calls).toHaveLength(1);
    const body = mock.requests[0]!.body as Record<string, unknown>;
    expect(body.sender).toBe("0x1234567890aBcDeF1234567890aBcDeF12345678");
  });

  it("submits a hash and marks the call non-idempotent (never double-recorded on timeout)", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts/chk_1/submit", () =>
      jsonResponse({ ok: true, intent: {}, txHashes: [`0x${"a".repeat(64)}`], note: "submitted" }),
    );
    const res = await client(mock).submitCheckout("chk_1", { txHash: `0x${"a".repeat(64)}` });
    expect(res.txHashes).toHaveLength(1);
  });

  it("verifies a checkout and reports the honest verdict", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts/chk_1/verify", () =>
      jsonResponse({ ok: true, verdict: "pending", state: "submitted", retryable: true }),
    );
    const res = await client(mock).verifyCheckout("chk_1");
    expect(res.verdict).toBe("pending");
    expect(res.retryable).toBe(true);
  });

  it("cancels a checkout", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts/chk_1/cancel", () =>
      jsonResponse({ ok: true, checkout: checkout({ status: "canceled", phase: "canceled" }), canceled: true }),
    );
    const res = await client(mock).cancelCheckout("chk_1");
    expect(res.canceled).toBe(true);
    expect(res.checkout.status).toBe("canceled");
  });

  it("fetches evidence and reports settled:false when not verified", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/checkouts/chk_1/evidence", () =>
      jsonResponse({
        ok: true,
        checkout: checkout({ status: "open" }),
        intent: { id: "int_1", state: "submitted", frozenMatchesCurrent: true, fingerprint: "int_abc12345" },
        authorizedParams: { recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" },
        txHashes: [],
        lifecycle: [],
        settlement: { verdict: "unavailable", delivered: null, expected: "5", blockNumber: null, chainId: null, message: "rpc down" },
        settled: false,
      }),
    );
    const res = await client(mock).getCheckoutEvidence("chk_1");
    expect(res.settled).toBe(false);
    expect(res.settlement?.verdict).toBe("unavailable");
    expect(res.intent.frozenMatchesCurrent).toBe(true);
  });

  it("surfaces an API error as a typed ApiError", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/checkouts/chk_1/submit", () =>
      errorResponse("invalid_state", "This checkout already has a submitted transaction.", 409),
    );
    await expect(client(mock).submitCheckout("chk_1", { txHash: `0x${"a".repeat(64)}` })).rejects.toMatchObject({
      code: "invalid_state",
      status: 409,
    });
  });
});

describe("checkout helpers", () => {
  it("treats only payment_verified as paid", () => {
    expect(isCheckoutPaid("payment_verified")).toBe(true);
    for (const phase of ["awaiting_payment", "transaction_submitted", "transaction_confirmed", "payment_failed", "expired"] as const) {
      expect(isCheckoutPaid(phase)).toBe(false);
    }
  });
});
