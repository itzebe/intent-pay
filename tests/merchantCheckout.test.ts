import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import { createDeveloperWithKey } from "@/lib/developer/credentials";

import { POST as checkoutsPOST, GET as checkoutsGET } from "@/app/api/v1/checkouts/route";
import { GET as checkoutGET } from "@/app/api/v1/checkouts/[id]/route";
import { POST as checkoutPreparePOST } from "@/app/api/v1/checkouts/[id]/prepare/route";
import { POST as checkoutSubmitPOST } from "@/app/api/v1/checkouts/[id]/submit/route";
import { POST as checkoutVerifyPOST } from "@/app/api/v1/checkouts/[id]/verify/route";
import { POST as checkoutCancelPOST } from "@/app/api/v1/checkouts/[id]/cancel/route";
import { GET as checkoutEvidenceGET } from "@/app/api/v1/checkouts/[id]/evidence/route";
import { GET as publicCheckoutGET } from "@/app/api/checkout/[token]/route";
import { POST as publicPreparePOST } from "@/app/api/checkout/[token]/prepare/route";
import { POST as publicSubmitPOST } from "@/app/api/checkout/[token]/submit/route";
import { POST as publicVerifyPOST } from "@/app/api/checkout/[token]/verify/route";
import { POST as intentsPOST } from "@/app/api/v1/intents/route";
import { POST as webhooksPOST } from "@/app/api/v1/webhooks/route";

/**
 * The merchant checkout API, exercised through its real route handlers with a
 * real (in-memory) SQLite store. The route is the contract a merchant depends on,
 * so these tests assert HTTP behaviour: authentication, tenant isolation,
 * the token boundary, freeze-before-sign, duplicate/expiry enforcement, and the
 * honesty rule that an order is `completed` only when settlement is verified.
 *
 * The chain is mocked at the boundary only (token resolution, quote, encode and
 * settlement), exactly as `developerApi.test.ts` does. Auth, the store, the
 * lifecycle, the checkout binding and the webhook signature are the real
 * implementations.
 */

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const SENDER = "0x1234567890aBcDeF1234567890aBcDeF12345678";
const USDC = { symbol: "USDC", name: "USD Coin", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, tint: "#2775CA" };

vi.mock("@/lib/server/discovery", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/discovery")>("@/lib/server/discovery");
  return {
    ...actual,
    ensureCatalog: vi.fn(async () => ({ count: 1, source: "test" })),
    resolveToken: vi.fn(async (input: string) => {
      if (input === "USDC" || input.toLowerCase() === USDC.address.toLowerCase()) {
        return { token: USDC, exists: true, source: "seed", listed: true };
      }
      return null;
    }),
  };
});

vi.mock("@/lib/server/quote", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/quote")>("@/lib/server/quote");
  return {
    ...actual,
    buildQuote: vi.fn(async () => ({
      ok: true as const,
      quote: {
        intent: { recipient: RECIPIENT, receiveToken: "USDC", receiveAmount: "5", amountMode: "recipient_receives" },
        network: "mainnet" as const,
        payToken: { ...USDC, native: false },
        receiveToken: { ...USDC, native: false },
        payAmount: "5",
        receiveAmount: "5",
        payUsd: 5,
        receiveUsd: 5,
        rate: 1,
        priceImpact: null,
        route: { kind: "direct" as const, hops: [], path: ["USDC"], tokens: [] },
        totalSenderCostUsd: 5.002,
        networkCostUsd: 0.002,
        networkCostUsdAvailable: true,
        gasLimit: 21000n,
        gasPriceWei: undefined,
        quotedAt: Date.now(),
        exactOutput: false,
        payPriceSource: "stable" as const,
        receivePriceSource: "stable" as const,
        receivePriceUnavailable: false,
        gas: { mode: "native" as const, rpc: "public" as const },
      },
    })),
  };
});

vi.mock("@/lib/execution/execute", async () => {
  const actual = await vi.importActual<typeof import("@/lib/execution/execute")>("@/lib/execution/execute");
  return {
    ...actual,
    encodeStep: vi.fn((step: { to: string; data?: string; value?: bigint }) => ({
      to: step.to,
      data: step.data ?? "0x",
      value: step.value ?? 0n,
    })),
  };
});

vi.mock("@/lib/developer/settlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/developer/settlement")>()),
  verifySettlement: vi.fn(),
  receiveTokenFor: vi.fn(() => USDC),
}));

import { verifySettlement } from "@/lib/developer/settlement";

function req(url: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

async function newKey(name = "Acme"): Promise<string> {
  const { issued } = await createDeveloperWithKey({ name });
  return issued.key;
}

async function createIntentViaApi(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await intentsPOST(
    req("http://localhost/api/v1/intents", {
      method: "POST",
      token,
      body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives", ...overrides },
    }),
  );
  const json = await res.json();
  return json.intent.id;
}

/** Create an intent and a checkout bound to it; returns the ids and token. */
async function createCheckoutViaApi(
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<{ intentId: string; checkoutId: string; checkoutToken: string }> {
  const intentId = await createIntentViaApi(token);
  const res = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId, ...overrides } }));
  const json = await res.json();
  return { intentId, checkoutId: json.checkout.id, checkoutToken: json.token };
}

beforeEach(() => {
  process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
  setStore(new SqliteStore(":memory:"));
  vi.mocked(verifySettlement).mockReset();
});
afterEach(() => {
  delete process.env.INTENT_PAY_DB_PATH;
  setStore(new MemoryStore());
  vi.clearAllMocks();
});

describe("checkout creation", () => {
  it("creates a checkout bound to an intent and returns a payment token", async () => {
    const token = await newKey();
    const intentId = await createIntentViaApi(token);
    const res = await checkoutsPOST(
      req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId, orderReference: "ORD-1001" } }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.created).toBe(true);
    expect(json.checkout.object).toBe("checkout");
    expect(json.checkout.status).toBe("open");
    expect(json.checkout.orderReference).toBe("ORD-1001");
    expect(json.token).toMatch(/^chk_[0-9a-f]{64}$/);
    // The intent is now frozen and awaiting the customer's wallet.
    const getRes = await checkoutGET(req(`http://localhost/api/v1/checkouts/${json.checkout.id}`, { token }), {
      params: Promise.resolve({ id: json.checkout.id }),
    });
    const got = await getRes.json();
    expect(got.checkout.phase).toBe("awaiting_payment");
    expect(got.intent.authorized).toBe(true);
  });

  it("requires a credential", async () => {
    const res = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", body: { intentId: "int_x" } }));
    expect(res.status).toBe(401);
  });

  it("replays an idempotent create instead of duplicating it", async () => {
    const token = await newKey();
    const intentId = await createIntentViaApi(token);
    const body = { intentId, idempotencyKey: "order-1" };
    const first = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body }));
    const second = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body }));
    const a = await first.json();
    const b = await second.json();
    expect(a.checkout.id).toBe(b.checkout.id);
    expect(a.token).toBe(b.token);
    expect(b.created).toBe(false);
  });

  it("refuses a second checkout for the same intent (one order per intent)", async () => {
    const token = await newKey();
    const intentId = await createIntentViaApi(token);
    await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId } }));
    const second = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId } }));
    expect(second.status).toBe(409);
  });

  it("rejects an out-of-range ttl", async () => {
    const token = await newKey();
    const intentId = await createIntentViaApi(token);
    const res = await checkoutsPOST(
      req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId, ttlSeconds: 5 } }),
    );
    expect(res.status).toBe(400);
  });

  it("isolates tenants: one merchant cannot create a checkout for another's intent", async () => {
    const a = await newKey("A");
    const b = await newKey("B");
    const intentId = await createIntentViaApi(a);
    const res = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token: b, body: { intentId } }));
    expect(res.status).toBe(404);
  });
});

describe("checkout tenant isolation", () => {
  it("does not reveal another tenant's checkout (404, never 403)", async () => {
    const a = await newKey("A");
    const b = await newKey("B");
    const { checkoutId } = await createCheckoutViaApi(a);
    const res = await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token: b }), {
      params: Promise.resolve({ id: checkoutId }),
    });
    expect(res.status).toBe(404);
  });

  it("lists only the authenticated merchant's checkouts", async () => {
    const a = await newKey("A");
    const b = await newKey("B");
    await createCheckoutViaApi(a);
    const res = await checkoutsGET(req("http://localhost/api/v1/checkouts", { token: b }));
    const json = await res.json();
    expect(json.checkouts).toHaveLength(0);
  });
});

describe("checkout lifecycle through the API", () => {
  it("prepare → submit → verify, and completes only after verification", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);

    // Prepare for the customer's wallet (merchant-authenticated convenience).
    const prep = await checkoutPreparePOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/prepare`, { method: "POST", token, body: { sender: SENDER } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(prep.status).toBe(200);
    const prepJson = await prep.json();
    expect(prepJson.calls.length).toBeGreaterThan(0);
    expect(prepJson.fingerprint).toMatch(/^int_[0-9a-f]{8}$/);

    // A prepared plan is not a payment — the order is still open.
    let status = await (await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(status.checkout.status).toBe("open");

    // Submit the broadcast hash.
    const txHash = `0x${"a".repeat(64)}`;
    const sub = await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(sub.status).toBe(200);
    status = await (await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(status.checkout.phase).toBe("transaction_submitted");
    expect(status.checkout.status).toBe("open");

    // Verify: the chain says the recipient received the funds.
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "verified",
      delivered: "5",
      expected: "5",
      blockNumber: 123456,
      chainId: 143,
      message: "ok",
    });
    const ver = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: {} }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(ver.status).toBe(200);
    const verJson = await ver.json();
    expect(verJson.verdict).toBe("verified");
    expect(verJson.state).toBe("verified");
    status = await (await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(status.checkout.status).toBe("completed");
    expect(status.checkout.phase).toBe("payment_verified");
  });

  it("does not complete the order when settlement is not verified", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"b".repeat(64)}`;
    await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "pending",
      delivered: null,
      expected: "5",
      blockNumber: null,
      chainId: 143,
      message: "not yet",
    });
    const ver = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: {} }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    const json = await ver.json();
    expect(json.verdict).toBe("pending");
    expect(json.retryable).toBe(true);
    const status = await (await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(status.checkout.status).toBe("open");
    expect(status.checkout.phase).toBe("transaction_submitted");
  });

  it("marks the order failed when the transaction reverted", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"c".repeat(64)}`;
    await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "reverted",
      delivered: null,
      expected: "5",
      blockNumber: 42,
      chainId: 143,
      message: "reverted",
    });
    const ver = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: {} }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    const json = await ver.json();
    expect(json.verdict).toBe("reverted");
    const status = await (await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(status.checkout.status).toBe("failed");
    expect(status.checkout.phase).toBe("payment_failed");
  });

  it("refuses a duplicate submission (the same transaction is recorded once)", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"d".repeat(64)}`;
    const first = await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(first.status).toBe(200);
    const second = await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(second.status).toBe(409);
    const json = await second.json();
    expect(json.error.code).toBe("invalid_state");
  });
});

describe("checkout cancellation", () => {
  it("cancels an open checkout and expires its intent", async () => {
    const token = await newKey();
    const { checkoutId, intentId } = await createCheckoutViaApi(token);
    const res = await checkoutCancelPOST(req(`http://localhost/api/v1/checkouts/${checkoutId}/cancel`, { method: "POST", token }), {
      params: Promise.resolve({ id: checkoutId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checkout.status).toBe("canceled");
    // A canceled order reads "canceled", never "expired" — even though canceling
    // also expires the bound intent (which would otherwise mask the reason).
    expect(json.checkout.phase).toBe("canceled");
    const got = await (await checkoutGET(req(`http://localhost/api/v1/checkouts/${checkoutId}`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(got.intent.state).toBe("expired");
    expect(got.checkout.phase).toBe("canceled");
    void intentId;
  });

  it("refuses to cancel a checkout that already has a submitted payment", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"e".repeat(64)}`;
    await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    const res = await checkoutCancelPOST(req(`http://localhost/api/v1/checkouts/${checkoutId}/cancel`, { method: "POST", token }), {
      params: Promise.resolve({ id: checkoutId }),
    });
    expect(res.status).toBe(409);
  });
});

describe("public checkout (customer, by token)", () => {
  it("serves the customer view with the payment parameters and no tenant data", async () => {
    const token = await newKey();
    const { checkoutToken, checkoutId } = await createCheckoutViaApi(token);
    const res = await publicCheckoutGET(req(`http://localhost/api/checkout/${checkoutToken}`), {
      params: Promise.resolve({ token: checkoutToken }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.checkout.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(json.checkout.amount).toBe("5");
    expect(json.checkout.receiveToken).toBe("USDC");
    expect(json.phase).toBe("awaiting_payment");
    // Never leaks the merchant's tenant id or internal ids.
    expect(JSON.stringify(json)).not.toContain("dev_");
    expect(json.checkout.id).toBe(checkoutId);
  });

  it("rejects a malformed token without a store lookup", async () => {
    const res = await publicCheckoutGET(req("http://localhost/api/checkout/not-a-token"), {
      params: Promise.resolve({ token: "not-a-token" }),
    });
    expect(res.status).toBe(404);
  });

  it("404s an unknown but well-formed token", async () => {
    const bogus = `chk_${"0".repeat(64)}`;
    const res = await publicCheckoutGET(req(`http://localhost/api/checkout/${bogus}`), {
      params: Promise.resolve({ token: bogus }),
    });
    expect(res.status).toBe(404);
  });

  it("lets the customer prepare, submit and verify with only the token", async () => {
    const token = await newKey();
    const { checkoutToken } = await createCheckoutViaApi(token);

    const prep = await publicPreparePOST(
      req(`http://localhost/api/checkout/${checkoutToken}/prepare`, { method: "POST", body: { sender: SENDER } }),
      { params: Promise.resolve({ token: checkoutToken }) },
    );
    expect(prep.status).toBe(200);
    const prepJson = await prep.json();
    expect(prepJson.calls.length).toBeGreaterThan(0);

    const txHash = `0x${"f".repeat(64)}`;
    const sub = await publicSubmitPOST(
      req(`http://localhost/api/checkout/${checkoutToken}/submit`, { method: "POST", body: { txHash } }),
      { params: Promise.resolve({ token: checkoutToken }) },
    );
    expect(sub.status).toBe(200);
    expect((await sub.json()).phase).toBe("transaction_submitted");

    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "verified",
      delivered: "5",
      expected: "5",
      blockNumber: 999,
      chainId: 143,
      message: "ok",
    });
    const ver = await publicVerifyPOST(
      req(`http://localhost/api/checkout/${checkoutToken}/verify`, { method: "POST", body: {} }),
      { params: Promise.resolve({ token: checkoutToken }) },
    );
    expect(ver.status).toBe(200);
    expect((await ver.json()).verdict).toBe("verified");

    const final = await (await publicCheckoutGET(req(`http://localhost/api/checkout/${checkoutToken}`), { params: Promise.resolve({ token: checkoutToken }) })).json();
    expect(final.phase).toBe("payment_verified");
  });

  it("cannot pay an expired checkout", async () => {
    const token = await newKey();
    const { checkoutId, checkoutToken } = await createCheckoutViaApi(token, { ttlSeconds: 60 });
    // Force expiry by moving the clock forward via the store.
    const { getStore } = await import("@/lib/store");
    await getStore().update("apiCheckouts", { id: checkoutId }, { expiresAt: Date.now() - 1000 });
    const res = await publicPreparePOST(
      req(`http://localhost/api/checkout/${checkoutToken}/prepare`, { method: "POST", body: { sender: SENDER } }),
      { params: Promise.resolve({ token: checkoutToken }) },
    );
    expect(res.status).toBe(409);
  });
});

describe("checkout evidence", () => {
  it("re-verifies settlement live and reports the frozen parameters", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"1".repeat(64)}`;
    await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "verified",
      delivered: "5",
      expected: "5",
      blockNumber: 777,
      chainId: 143,
      message: "ok",
    });
    const res = await checkoutEvidenceGET(req(`http://localhost/api/v1/checkouts/${checkoutId}/evidence`, { token }), {
      params: Promise.resolve({ id: checkoutId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settled).toBe(true);
    expect(json.settlement.verdict).toBe("verified");
    expect(json.txHashes).toContain(txHash);
    expect(json.authorizedParams.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(json.intent.frozenMatchesCurrent).toBe(true);
    expect(json.intent.fingerprint).toMatch(/^int_[0-9a-f]{8}$/);
  });

  it("reports settled:false when the chain cannot confirm", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"2".repeat(64)}`;
    await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "unavailable",
      delivered: null,
      expected: "5",
      blockNumber: null,
      chainId: null,
      message: "rpc down",
    });
    const res = await checkoutEvidenceGET(req(`http://localhost/api/v1/checkouts/${checkoutId}/evidence`, { token }), {
      params: Promise.resolve({ id: checkoutId }),
    });
    const json = await res.json();
    expect(json.settled).toBe(false);
    expect(json.settlement.verdict).toBe("unavailable");
  });
});

describe("checkout webhooks", () => {
  it("emits checkout.created, payment.submitted, payment.confirmed and payment.verified", async () => {
    const token = await newKey();
    // Register a webhook for the order-scoped events.
    await webhooksPOST(
      req("http://localhost/api/v1/webhooks", {
        method: "POST",
        token,
        body: { url: "https://example.com/hook", events: ["checkout.created", "payment.submitted", "payment.confirmed", "payment.verified"] },
      }),
    );
    const { checkoutId } = await createCheckoutViaApi(token);
    const txHash = `0x${"3".repeat(64)}`;
    await checkoutSubmitPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/submit`, { method: "POST", token, body: { txHash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "verified",
      delivered: "5",
      expected: "5",
      blockNumber: 555,
      chainId: 143,
      message: "ok",
    });
    await checkoutVerifyPOST(req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: {} }), {
      params: Promise.resolve({ id: checkoutId }),
    });

    const { getStore } = await import("@/lib/store");
    const deliveries = await getStore().findMany("apiWebhookDeliveries", {}, { orderBy: "createdAt", dir: "asc" });
    const events = deliveries.map((d) => d.event);
    expect(events).toContain("checkout.created");
    expect(events).toContain("payment.submitted");
    expect(events).toContain("payment.confirmed");
    expect(events).toContain("payment.verified");
    // A verified order emits payment.verified exactly once.
    expect(events.filter((e) => e === "payment.verified")).toHaveLength(1);
  });
});
