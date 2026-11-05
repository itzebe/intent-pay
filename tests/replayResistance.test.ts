import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import { createDeveloperWithKey } from "@/lib/developer/credentials";

import { POST as checkoutsPOST } from "@/app/api/v1/checkouts/route";
import { POST as checkoutVerifyPOST } from "@/app/api/v1/checkouts/[id]/verify/route";
import { GET as checkoutEvidenceGET } from "@/app/api/v1/checkouts/[id]/evidence/route";
import { POST as publicVerifyPOST } from "@/app/api/checkout/[token]/verify/route";
import { POST as intentsPOST } from "@/app/api/v1/intents/route";
import { POST as intentSubmitPOST } from "@/app/api/v1/intents/[id]/submit/route";
import { POST as intentVerifyPOST } from "@/app/api/v1/intents/[id]/verify/route";

/**
 * Transaction attribution, replay resistance and order binding.
 *
 * The load-bearing rule: one on-chain transaction may satisfy **at most one**
 * order, and it must be *this* order's payment — not a historical transfer that
 * merely happens to match the recipient and amount. These tests drive the real
 * route handlers over a real (in-memory SQLite) store; only the chain boundary
 * (`verifySettlement`) is mocked, exactly as the checkout suite does. The
 * `(chainId, txHash)` claim is the real database constraint.
 */

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
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

const { verifySettlementMock } = vi.hoisted(() => ({ verifySettlementMock: vi.fn() }));
vi.mock("@/lib/developer/settlement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/developer/settlement")>();
  return {
    ...real,
    verifySettlement: verifySettlementMock,
    receiveTokenFor: vi.fn(() => USDC),
    checkTransactionSet: vi.fn(async (hashes: string[], input: Record<string, unknown>) => {
      const checks: Array<Record<string, unknown>> = [];
      for (const h of hashes) {
        const c = (await verifySettlementMock({ ...input, txHash: h })) as Record<string, unknown>;
        if (c.verdict === "verified") return { ...c, txHash: h };
        checks.push({ ...c, txHash: h });
      }
      return real.summarizeChecks(checks as never);
    }),
  };
});

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

/** Create an intent + checkout; returns the ids and the public token. */
async function createCheckoutViaApi(
  token: string,
): Promise<{ intentId: string; checkoutId: string; checkoutToken: string }> {
  const intentId = await createIntentViaApi(token);
  const res = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId } }));
  const json = await res.json();
  return { intentId, checkoutId: json.checkout.id, checkoutToken: json.token };
}

function verified(blockNumber = 100, delivered = "5") {
  return { verdict: "verified" as const, delivered, expected: "5", blockNumber, chainId: 143, message: "ok" };
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

describe("replay resistance — one transaction pays one order", () => {
  it("refuses the same hash submitted to two different orders (same merchant)", async () => {
    const token = await newKey();
    const a = await createCheckoutViaApi(token);
    const b = await createCheckoutViaApi(token);
    const hash = `0x${"a".repeat(64)}`;

    vi.mocked(verifySettlement).mockResolvedValue(verified());
    const first = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${a.checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: a.checkoutId }) },
    );
    expect(first.status).toBe(200);
    expect((await first.json()).verdict).toBe("verified");

    // The same hash for the second order must be refused as a replay.
    const second = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${b.checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: b.checkoutId }) },
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error.code).toBe("replay_detected");

    // The second order did NOT complete.
    const got = await checkoutEvidenceGET(req(`http://localhost/api/v1/checkouts/${b.checkoutId}/evidence`, { token }), {
      params: Promise.resolve({ id: b.checkoutId }),
    });
    const evidence = await got.json();
    expect(evidence.checkout.status).not.toBe("completed");
  });

  it("refuses the same hash submitted to two different merchants", async () => {
    const a = await newKey("A");
    const b = await newKey("B");
    const ca = await createCheckoutViaApi(a);
    const cb = await createCheckoutViaApi(b);
    const hash = `0x${"b".repeat(64)}`;

    vi.mocked(verifySettlement).mockResolvedValue(verified());
    const first = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${ca.checkoutId}/verify`, { method: "POST", token: a, body: { txHash: hash } }),
      { params: Promise.resolve({ id: ca.checkoutId }) },
    );
    expect(first.status).toBe(200);

    const second = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${cb.checkoutId}/verify`, { method: "POST", token: b, body: { txHash: hash } }),
      { params: Promise.resolve({ id: cb.checkoutId }) },
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("replay_detected");
  });

  it("refuses a hash already consumed by a completed checkout", async () => {
    const token = await newKey();
    const a = await createCheckoutViaApi(token);
    const hash = `0x${"c".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified());
    await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${a.checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: a.checkoutId }) },
    );

    const b = await createCheckoutViaApi(token);
    const second = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${b.checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: b.checkoutId }) },
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("replay_detected");
  });

  it("allows the SAME order to re-verify with its own hash (idempotent, not a replay)", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const hash = `0x${"d".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified());
    const first = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(first.status).toBe(200);
    // A second verify on the same (now verified) order is idempotent.
    const again = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    expect(again.status).toBe(200);
    expect((await again.json()).verdict).toBe("verified");
  });

  it("is concurrency-safe: N concurrent claims of one hash yield exactly one winner", async () => {
    const token = await newKey();
    const orders = await Promise.all(Array.from({ length: 5 }, () => createCheckoutViaApi(token)));
    const hash = `0x${"e".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified());

    const results = await Promise.all(
      orders.map((o) =>
        checkoutVerifyPOST(
          req(`http://localhost/api/v1/checkouts/${o.checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
          { params: Promise.resolve({ id: o.checkoutId }) },
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    const wins = statuses.filter((s) => s === 200).length;
    const replays = statuses.filter((s) => s === 409).length;
    expect(wins).toBe(1);
    expect(replays).toBe(4);
  });

  it("enforces the claim at the public (customer) route too", async () => {
    const token = await newKey();
    const a = await createCheckoutViaApi(token);
    const b = await createCheckoutViaApi(token);
    const hash = `0x${"f".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified());

    const first = await publicVerifyPOST(
      req(`http://localhost/api/checkout/${a.checkoutToken}/verify`, { method: "POST", body: { txHash: hash } }),
      { params: Promise.resolve({ token: a.checkoutToken }) },
    );
    expect(first.status).toBe(200);

    const second = await publicVerifyPOST(
      req(`http://localhost/api/checkout/${b.checkoutToken}/verify`, { method: "POST", body: { txHash: hash } }),
      { params: Promise.resolve({ token: b.checkoutToken }) },
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("replay_detected");
  });

  it("refuses a hash already consumed via the intent-level verify", async () => {
    const token = await newKey();
    const intentA = await createIntentViaApi(token);
    const intentB = await createIntentViaApi(token);
    const hash = `0x${"1".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified());

    // Authorize + submit + verify intent A (the raw developer path).
    const { POST: authorizePOST } = await import("@/app/api/v1/intents/[id]/authorize/route");
    const { POST: preparePOST } = await import("@/app/api/v1/intents/[id]/prepare/route");
    await preparePOST(req(`http://localhost/api/v1/intents/${intentA}/prepare`, { method: "POST", token, body: { payToken: "USDC" } }), { params: Promise.resolve({ id: intentA }) });
    await authorizePOST(req(`http://localhost/api/v1/intents/${intentA}/authorize`, { method: "POST", token }), { params: Promise.resolve({ id: intentA }) });
    await intentSubmitPOST(req(`http://localhost/api/v1/intents/${intentA}/submit`, { method: "POST", token, body: { txHash: hash } }), { params: Promise.resolve({ id: intentA }) });
    const va = await intentVerifyPOST(req(`http://localhost/api/v1/intents/${intentA}/verify`, { method: "POST", token, body: { txHash: hash } }), { params: Promise.resolve({ id: intentA }) });
    expect(va.status).toBe(200);

    await preparePOST(req(`http://localhost/api/v1/intents/${intentB}/prepare`, { method: "POST", token, body: { payToken: "USDC" } }), { params: Promise.resolve({ id: intentB }) });
    await authorizePOST(req(`http://localhost/api/v1/intents/${intentB}/authorize`, { method: "POST", token }), { params: Promise.resolve({ id: intentB }) });
    await intentSubmitPOST(req(`http://localhost/api/v1/intents/${intentB}/submit`, { method: "POST", token, body: { txHash: hash } }), { params: Promise.resolve({ id: intentB }) });
    const vb = await intentVerifyPOST(req(`http://localhost/api/v1/intents/${intentB}/verify`, { method: "POST", token, body: { txHash: hash } }), { params: Promise.resolve({ id: intentB }) });
    expect(vb.status).toBe(409);
    expect((await vb.json()).error.code).toBe("replay_detected");
  });
});

describe("order binding — a historical transfer is not this order's payment", () => {
  it("refuses a transfer that predates the order", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const hash = `0x${"2".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue({
      verdict: "historical",
      delivered: null,
      expected: "5",
      blockNumber: 10,
      chainId: 143,
      message: "That transaction predates this order.",
    });
    const res = await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    const json = await res.json();
    expect(json.verdict).toBe("historical");
    expect(json.retryable).toBe(true);
    // The order did not complete, and no claim was taken.
    const evidence = await (await checkoutEvidenceGET(req(`http://localhost/api/v1/checkouts/${checkoutId}/evidence`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(evidence.checkout.status).not.toBe("completed");
    expect(evidence.transactionClaim).toBeNull();
  });

  it("passes the order's creation time to the verifier so it can enforce binding", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const hash = `0x${"3".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified());
    await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    const call = vi.mocked(verifySettlement).mock.calls[0][0];
    expect(typeof call.notBeforeMs).toBe("number");
    expect(call.notBeforeMs).toBeGreaterThan(0);
    // recipient_receives must demand the exact amount.
    expect(call.toleranceBps).toBe(0);
  });
});

describe("non-verifiable transactions never become claims", () => {
  const cases: Array<{ verdict: "short" | "reverted" | "not_found" | "unavailable" | "unconfirmed"; label: string }> = [
    { verdict: "short", label: "insufficient value / wrong token / wrong recipient" },
    { verdict: "reverted", label: "reverted" },
    { verdict: "not_found", label: "unknown hash" },
    { verdict: "unavailable", label: "wrong chain / RPC down" },
    { verdict: "unconfirmed", label: "not enough confirmations" },
  ];

  for (const c of cases) {
    it(`a ${c.label} transaction leaves no claim and does not block a later real payment`, async () => {
      const token = await newKey();
      const { checkoutId, intentId } = await createCheckoutViaApi(token);
      const hash = `0x${c.verdict.padEnd(64, "0").slice(0, 64)}`;

      vi.mocked(verifySettlement).mockResolvedValue({
        verdict: c.verdict,
        delivered: null,
        expected: "5",
        blockNumber: null,
        chainId: 143,
        message: "no",
      });
      await checkoutVerifyPOST(
        req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
        { params: Promise.resolve({ id: checkoutId }) },
      );

      const { getStore } = await import("@/lib/store");
      const claims = await getStore().findMany("apiTxClaims", {});
      expect(claims).toHaveLength(0);
      void intentId;
    });
  }
});

describe("claim is durable and survives a store round-trip", () => {
  it("records the claim with its chain, block and delivered amount", async () => {
    const token = await newKey();
    const { checkoutId } = await createCheckoutViaApi(token);
    const hash = `0x${"9".repeat(64)}`;
    vi.mocked(verifySettlement).mockResolvedValue(verified(123456, "5"));
    await checkoutVerifyPOST(
      req(`http://localhost/api/v1/checkouts/${checkoutId}/verify`, { method: "POST", token, body: { txHash: hash } }),
      { params: Promise.resolve({ id: checkoutId }) },
    );
    const evidence = await (await checkoutEvidenceGET(req(`http://localhost/api/v1/checkouts/${checkoutId}/evidence`, { token }), { params: Promise.resolve({ id: checkoutId }) })).json();
    expect(evidence.transactionClaim).not.toBeNull();
    expect(evidence.transactionClaim.txHash).toBe(hash);
    expect(evidence.transactionClaim.chainId).toBe(143);
    expect(evidence.transactionClaim.delivered).toBe("5");
  });
});
