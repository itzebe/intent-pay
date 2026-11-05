import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import { createDeveloperWithKey } from "@/lib/developer/credentials";

import { GET as capabilitiesGET } from "@/app/api/v1/capabilities/route";
import { POST as intentsPOST, GET as intentsGET } from "@/app/api/v1/intents/route";
import { GET as intentGET } from "@/app/api/v1/intents/[id]/route";
import { POST as validatePOST } from "@/app/api/v1/intents/[id]/validate/route";
import { POST as preparePOST } from "@/app/api/v1/intents/[id]/prepare/route";
import { POST as authorizePOST } from "@/app/api/v1/intents/[id]/authorize/route";
import { POST as submitPOST } from "@/app/api/v1/intents/[id]/submit/route";
import { POST as verifyPOST } from "@/app/api/v1/intents/[id]/verify/route";
import { POST as webhooksPOST, GET as webhooksGET } from "@/app/api/v1/webhooks/route";
import { DELETE as webhookDELETE } from "@/app/api/v1/webhooks/[id]/route";
import { GET as deliveriesGET } from "@/app/api/v1/webhooks/[id]/deliveries/route";
import { GET as developersGET } from "@/app/api/v1/developers/route";
import { POST as keysPOST } from "@/app/api/v1/developers/keys/route";

/**
 * The external developer API, exercised through its real route handlers with a
 * real (in-memory) store. The route is the contract an integrator depends on, so
 * these tests assert the HTTP behaviour: authentication, tenant isolation,
 * validation, the freeze-before-sign ordering, and the honesty rules (a prepared
 * transaction is not a payment; only an on-chain verdict verifies settlement).
 *
 * The chain is mocked at the boundary only: `resolveToken` returns a fixed USDC,
 * `buildQuote` returns a deterministic quote, and `verifySettlement` is driven by
 * the tests. Everything else — auth, the store, the lifecycle, the webhook
 * signature — is the real implementation.
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

async function newKey(name = "Acme"): Promise<{ token: string; developerId: string }> {
  const { developer, issued } = await createDeveloperWithKey({ name });
  return { token: issued.key, developerId: developer.id };
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
  return json.intent?.id;
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

describe("capabilities", () => {
  it("is public and advertises only implemented capabilities", async () => {
    const res = await capabilitiesGET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.apiVersion).toBe("v1");
    expect(json.network.chainId).toBe(143);
    expect(json.features.credentialCanSign).toBe(false);
    expect(json.features.keyCustody).toBe(false);
    expect(json.endpoints.map((e: { path: string }) => e.path)).toContain("/api/v1/intents");
    // The capabilities document must never carry a secret-shaped value.
    expect(JSON.stringify(json)).not.toMatch(/ipk_/);
  });
});

describe("authentication", () => {
  it("refuses a request with no credential", async () => {
    const res = await intentsGET(req("http://localhost/api/v1/intents"));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthorized");
  });

  it("refuses a malformed credential", async () => {
    const res = await intentsGET(req("http://localhost/api/v1/intents", { token: "nonsense" }));
    expect(res.status).toBe(401);
  });
});

describe("intents", () => {
  it("creates an intent and returns it", async () => {
    const { token } = await newKey();
    const res = await intentsPOST(
      req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives" } }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.intent.state).toBe("created");
    expect(json.intent.recipient).toBe(RECIPIENT.toLowerCase());
    expect(json.created).toBe(true);
  });

  it("replays an idempotent create instead of duplicating it", async () => {
    const { token } = await newKey();
    const first = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives", idempotencyKey: "abc" } }));
    const firstJson = await first.json();
    const second = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives", idempotencyKey: "abc" } }));
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.created).toBe(false);
    expect(secondJson.intent.id).toBe(firstJson.intent.id);
  });

  it("rejects an idempotency key reused with different parameters", async () => {
    const { token } = await newKey();
    await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives", idempotencyKey: "abc" } }));
    const res = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "9", amountMode: "recipient_receives", idempotencyKey: "abc" } }));
    expect(res.status).toBe(409);
  });

  it("validates the request shape", async () => {
    const { token } = await newKey();
    const badRecipient = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: "nope", receiveToken: "USDC", amount: "5", amountMode: "recipient_receives" } }));
    expect(badRecipient.status).toBe(400);
    const badChain = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives", chainId: 1 } }));
    expect(badChain.status).toBe(422);
    expect((await badChain.json()).error.code).toBe("invalid_chain");
    const unknownToken = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "NOTACOIN", amount: "5", amountMode: "recipient_receives", chainId: 143 } }));
    expect(unknownToken.status).toBe(422);
    expect((await unknownToken.json()).error.code).toBe("unsupported_token");
  });

  it("isolates tenants: one developer cannot read another's intent", async () => {
    const a = await newKey("A");
    const b = await newKey("B");
    const id = await createIntentViaApi(a.token);
    const asB = await intentGET(req(`http://localhost/api/v1/intents/${id}`, { token: b.token }), { params: Promise.resolve({ id }) });
    expect(asB.status).toBe(404);
    const asA = await intentGET(req(`http://localhost/api/v1/intents/${id}`, { token: a.token }), { params: Promise.resolve({ id }) });
    expect(asA.status).toBe(200);
  });
});

describe("lifecycle through the API", () => {
  it("validate → prepare → authorize → submit → verify, in order", async () => {
    const { token } = await newKey();
    const id = await createIntentViaApi(token);
    const params = { params: Promise.resolve({ id }) };

    const validate = await validatePOST(req(`http://localhost/api/v1/intents/${id}/validate`, { method: "POST", token }), params);
    expect(validate.status).toBe(200);
    expect((await validate.json()).valid).toBe(true);

    const prepare = await preparePOST(req(`http://localhost/api/v1/intents/${id}/prepare`, { method: "POST", token, body: { sender: RECIPIENT } }), params);
    expect(prepare.status).toBe(200);
    const prepared = await prepare.json();
    expect(prepared.calls.length).toBeGreaterThan(0);
    expect(prepared.fingerprint).toMatch(/^int_/);

    const authorize = await authorizePOST(req(`http://localhost/api/v1/intents/${id}/authorize`, { method: "POST", token }), params);
    expect(authorize.status).toBe(200);
    const auth = await authorize.json();
    expect(auth.intent.authorized).toBe(true);
    expect(auth.state).toBe("awaiting_authorization");

    // Submitting before the wallet broadcast is a record of the hash, not a payment.
    const submit = await submitPOST(req(`http://localhost/api/v1/intents/${id}/submit`, { method: "POST", token, body: { txHash: `0x${"a".repeat(64)}` } }), params);
    expect(submit.status).toBe(200);
    expect((await submit.json()).intent.state).toBe("submitted");

    // A confirmed-but-unverified transaction is not a verified payment.
    vi.mocked(verifySettlement).mockResolvedValue({ verdict: "verified", delivered: "5", expected: "5", blockNumber: 100, chainId: 143, message: "ok" });
    const verify = await verifyPOST(req(`http://localhost/api/v1/intents/${id}/verify`, { method: "POST", token }), params);
    expect(verify.status).toBe(200);
    const verdict = await verify.json();
    expect(verdict.verdict).toBe("verified");
    expect(verdict.state).toBe("verified");
  });

  it("refuses submit before authorize (parameters not frozen)", async () => {
    const { token } = await newKey();
    const id = await createIntentViaApi(token);
    const res = await submitPOST(
      req(`http://localhost/api/v1/intents/${id}/submit`, { method: "POST", token, body: { txHash: `0x${"a".repeat(64)}` } }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(409);
  });

  it("refuses to verify a transaction the chain did not settle", async () => {
    const { token } = await newKey();
    const id = await createIntentViaApi(token);
    const params = { params: Promise.resolve({ id }) };
    await preparePOST(req(`http://localhost/api/v1/intents/${id}/prepare`, { method: "POST", token, body: { sender: RECIPIENT } }), params);
    await authorizePOST(req(`http://localhost/api/v1/intents/${id}/authorize`, { method: "POST", token }), params);
    await submitPOST(req(`http://localhost/api/v1/intents/${id}/submit`, { method: "POST", token, body: { txHash: `0x${"a".repeat(64)}` } }), params);

    vi.mocked(verifySettlement).mockResolvedValue({ verdict: "pending", delivered: null, expected: "5", blockNumber: null, chainId: 143, message: "not yet" });
    const pending = await verifyPOST(req(`http://localhost/api/v1/intents/${id}/verify`, { method: "POST", token }), params);
    const pendingJson = await pending.json();
    expect(pendingJson.verdict).toBe("pending");
    expect(pendingJson.state).toBe("submitted"); // unchanged
    expect(pendingJson.retryable).toBe(true);
  });

  it("marks an intent failed when the transaction reverted", async () => {
    const { token } = await newKey();
    const id = await createIntentViaApi(token);
    const params = { params: Promise.resolve({ id }) };
    await preparePOST(req(`http://localhost/api/v1/intents/${id}/prepare`, { method: "POST", token, body: { sender: RECIPIENT } }), params);
    await authorizePOST(req(`http://localhost/api/v1/intents/${id}/authorize`, { method: "POST", token }), params);
    await submitPOST(req(`http://localhost/api/v1/intents/${id}/submit`, { method: "POST", token, body: { txHash: `0x${"a".repeat(64)}` } }), params);
    vi.mocked(verifySettlement).mockResolvedValue({ verdict: "reverted", delivered: null, expected: "5", blockNumber: 100, chainId: 143, message: "reverted" });
    const res = await verifyPOST(req(`http://localhost/api/v1/intents/${id}/verify`, { method: "POST", token }), params);
    const json = await res.json();
    expect(json.verdict).toBe("reverted");
    expect(json.state).toBe("failed");
  });
});

describe("webhooks", () => {
  it("registers a webhook and returns the secret exactly once", async () => {
    const { token } = await newKey();
    const created = await webhooksPOST(req("http://localhost/api/v1/webhooks", { method: "POST", token, body: { url: "https://example.com/hook", events: ["intent.created"] } }));
    expect(created.status).toBe(201);
    const json = await created.json();
    expect(json.secret).toMatch(/^whsec_/);
    expect(json.webhook.events).toEqual(["intent.created"]);

    // Listing never returns the secret again.
    const list = await webhooksGET(req("http://localhost/api/v1/webhooks", { token }));
    const listed = await list.json();
    expect(JSON.stringify(listed)).not.toContain(json.secret);
  });

  it("rejects a non-HTTPS webhook URL", async () => {
    const { token } = await newKey();
    const res = await webhooksPOST(req("http://localhost/api/v1/webhooks", { method: "POST", token, body: { url: "http://example.com/hook", events: ["*"] } }));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown event name", async () => {
    const { token } = await newKey();
    const res = await webhooksPOST(req("http://localhost/api/v1/webhooks", { method: "POST", token, body: { url: "https://example.com/hook", events: ["made.up"] } }));
    expect(res.status).toBe(400);
  });

  it("scopes webhook deletion and delivery history by tenant", async () => {
    const a = await newKey("A");
    const b = await newKey("B");
    const created = await webhooksPOST(req("http://localhost/api/v1/webhooks", { method: "POST", token: a.token, body: { url: "https://example.com/hook", events: ["*"] } }));
    const hookId = (await created.json()).webhook.id;
    const asB = await webhookDELETE(req(`http://localhost/api/v1/webhooks/${hookId}`, { method: "DELETE", token: b.token }), { params: Promise.resolve({ id: hookId }) });
    expect(asB.status).toBe(404);
    const delivAsB = await deliveriesGET(req(`http://localhost/api/v1/webhooks/${hookId}/deliveries`, { token: b.token }), { params: Promise.resolve({ id: hookId }) });
    expect(delivAsB.status).toBe(404);
    const asA = await webhookDELETE(req(`http://localhost/api/v1/webhooks/${hookId}`, { method: "DELETE", token: a.token }), { params: Promise.resolve({ id: hookId }) });
    expect(asA.status).toBe(200);
  });
});

describe("developer keys", () => {
  it("lists keys without ever returning a secret", async () => {
    const { token } = await newKey();
    const res = await developersGET(req("http://localhost/api/v1/developers", { token }));
    const json = await res.json();
    expect(json.keys.length).toBe(1);
    expect(JSON.stringify(json)).not.toMatch(/ipk_/);
    expect(json.keys[0].prefix).toBeTruthy();
  });

  it("rotates a key, invalidating the old one", async () => {
    const { token } = await newKey();
    const listed = await (await developersGET(req("http://localhost/api/v1/developers", { token }))).json();
    const keyId = listed.keys[0].id;
    const rotated = await keysPOST(req("http://localhost/api/v1/developers/keys", { method: "POST", token, body: { action: "rotate", keyId } }));
    const json = await rotated.json();
    expect(json.key).toMatch(/^ipk_/);
    // The old token no longer authenticates.
    const after = await intentsGET(req("http://localhost/api/v1/intents", { token }));
    expect(after.status).toBe(401);
  });
});
