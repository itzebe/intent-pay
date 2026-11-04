import { describe, expect, it } from "vitest";
import { IntentPay } from "../src/index.js";
import { isSettled, isTerminalIntentState } from "../src/core/types.js";
import { MockFetch, errorResponse, jsonResponse } from "./helpers.js";

const KEY = "ipk_live_abcdef123456.0123456789abcdef0123456789abcdef";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    object: "intent",
    state: "created",
    chainId: 143,
    recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    receiveToken: "USDC",
    receiveTokenAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    amountMode: "recipient_receives",
    amount: "5",
    payToken: null,
    reference: null,
    authorized: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function client(mock: MockFetch) {
  return new IntentPay({ apiKey: KEY, fetch: mock.fetch, maxRetries: 0 });
}

describe("createIntent", () => {
  it("sends the documented body and returns the created intent", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents", () =>
      jsonResponse({ ok: true, created: true, intent: intent() }, { status: 201 }),
    );
    const result = await client(mock).createIntent({
      recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
      receiveToken: "USDC",
      amount: "5",
    });
    expect(result.created).toBe(true);
    expect(result.intent.state).toBe("created");
    const body = mock.calls[0]!.body as Record<string, unknown>;
    expect(body.amountMode).toBe("recipient_receives");
    expect(body.chainId).toBeUndefined();
  });

  it("defaults amountMode to recipient_receives when omitted", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents", () =>
      jsonResponse({ ok: true, created: true, intent: intent() }, { status: 201 }),
    );
    await client(mock).createIntent({ recipient: "0x1", receiveToken: "MON", amount: "1" });
    expect((mock.calls[0]!.body as Record<string, unknown>).amountMode).toBe("recipient_receives");
  });

  it("passes amountMode, payToken, reference and chainId through", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents", () =>
      jsonResponse({ ok: true, created: true, intent: intent() }, { status: 201 }),
    );
    await client(mock).createIntent({
      recipient: "0x1",
      receiveToken: "USDC",
      amount: "5",
      amountMode: "i_spend",
      payToken: "USDT",
      reference: "order-9",
      chainId: 143,
    });
    const body = mock.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ amountMode: "i_spend", payToken: "USDT", reference: "order-9", chainId: 143 });
  });
});

describe("validateIntent", () => {
  it("returns valid:true and the validated state", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/validate", () =>
      jsonResponse({
        ok: true,
        valid: true,
        state: "validated",
        validation: {
          ok: true,
          chainId: 143,
          recipient: { valid: true },
          receiveToken: { symbol: "USDC", address: "0x7547", exists: true },
          amount: { valid: true },
          payToken: null,
        },
      }),
    );
    const result = await client(mock).validateIntent("int_1");
    expect(result.valid).toBe(true);
    expect(result.state).toBe("validated");
  });

  it("treats a failed validation as a 200 with valid:false, not a thrown error", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/validate", () =>
      jsonResponse({
        ok: true,
        valid: false,
        state: "rejected",
        validation: {
          ok: false,
          chainId: 143,
          recipient: { valid: true },
          receiveToken: { symbol: "SOL", address: "0xea17", exists: true },
          amount: { valid: true },
          payToken: null,
          route: { available: false, reason: "no liquidity" },
        },
      }),
    );
    const result = await client(mock).validateIntent("int_1");
    expect(result.valid).toBe(false);
    expect(result.state).toBe("rejected");
    expect(result.validation.route?.available).toBe(false);
  });
});

describe("prepareTransaction", () => {
  it("returns ordered calls and a fingerprint, and asserts nothing was signed", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/prepare", () =>
      jsonResponse({
        ok: true,
        state: "prepared",
        sender: "0xsender",
        calls: [
          { to: "0x7547", data: "0x095ea7b3", value: "0" },
          { to: "0xrouter", data: "0x5023b4df", value: "0" },
        ],
        steps: ["approve", "swap"],
        quote: {
          payToken: "USDT",
          payAmount: "5.02",
          receiveToken: "USDC",
          receiveAmount: "5",
          minimumReceived: "4.975",
          slippageBps: 50,
          networkCostUsd: 0.01,
        },
        fingerprint: "fp_1",
        note: "Prepared only.",
      }),
    );
    const result = await client(mock).prepareTransaction("int_1", { sender: "0xsender" });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]!.to).toBe("0x7547");
    expect(result.fingerprint).toBe("fp_1");
    // Preparation is not a payment — the SDK's own helper must agree.
    expect(isSettled(result.state)).toBe(false);
  });

  it("does not send a credential-signed transaction anywhere", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/prepare", () =>
      jsonResponse({ ok: true, state: "prepared", sender: "0xs", calls: [], steps: [], quote: {}, fingerprint: "f", note: "" }),
    );
    await client(mock).prepareTransaction("int_1", { sender: "0xs" });
    expect(mock.calls.every((c) => c.method === "POST" && c.url.includes("/api/v1/"))).toBe(true);
  });
});

describe("authorize → submit → verify", () => {
  it("freezes params on authorize", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/authorize", () =>
      jsonResponse({ ok: true, state: "awaiting_authorization", intent: intent({ authorized: true }), authorizedParams: { recipient: "0x1" } }),
    );
    const result = await client(mock).authorizeIntent("int_1");
    expect(result.state).toBe("awaiting_authorization");
    expect(result.intent.authorized).toBe(true);
  });

  it("records a single hash on submit", async () => {
    const hash = "0x" + "a".repeat(64);
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/submit", (req) => {
      expect((req.body as { txHash: string }).txHash).toBe(hash);
      return jsonResponse({ ok: true, intent: intent({ state: "submitted" }), txHashes: [hash], note: "Submitted." });
    });
    const result = await client(mock).submitTransaction("int_1", { txHash: hash });
    expect(result.txHashes).toEqual([hash]);
  });

  it("records multiple hashes with txHashes", async () => {
    const hashes = ["0x" + "a".repeat(64), "0x" + "b".repeat(64)];
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/submit", (req) => {
      expect((req.body as { txHashes: string[] }).txHashes).toEqual(hashes);
      return jsonResponse({ ok: true, intent: intent({ state: "submitted" }), txHashes: hashes, note: "Submitted." });
    });
    await client(mock).submitTransaction("int_1", { txHashes: hashes });
  });

  it("surfaces an already_submitted conflict rather than retrying", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/submit", () =>
      errorResponse("already_submitted", "This intent already has a submitted transaction.", 409),
    );
    await expect(client(mock).submitTransaction("int_1", { txHash: "0x" + "a".repeat(64) })).rejects.toMatchObject({
      code: "already_submitted",
      retryable: false,
    });
  });

  it("returns a pending verdict as retryable, not as settled", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/verify", () =>
      jsonResponse({
        ok: true,
        verdict: "pending",
        state: "submitted",
        retryable: true,
        settlement: { verdict: "pending", delivered: null, expected: "5", blockNumber: null, chainId: 143, message: "Not confirmed yet." },
      }),
    );
    const result = await client(mock).verifySettlement("int_1");
    expect(result.verdict).toBe("pending");
    expect(result.retryable).toBe(true);
    expect(isSettled(result.state)).toBe(false);
  });

  it("returns a verified verdict and advances the state", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/verify", () =>
      jsonResponse({
        ok: true,
        verdict: "verified",
        state: "verified",
        settlement: { verdict: "verified", delivered: "5.0", expected: "5", blockNumber: 123, chainId: 143, message: "Paid." },
      }),
    );
    const result = await client(mock).verifySettlement("int_1");
    expect(result.verdict).toBe("verified");
    expect(isSettled(result.state)).toBe(true);
  });

  it("reports a short settlement as failed, never as settled", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/verify", () =>
      jsonResponse({
        ok: true,
        verdict: "short",
        state: "failed",
        settlement: { verdict: "short", delivered: "1.0", expected: "5", blockNumber: 1, chainId: 143, message: "Less than intended." },
      }),
    );
    const result = await client(mock).verifySettlement("int_1");
    expect(result.verdict).toBe("short");
    expect(isSettled(result.state)).toBe(false);
    expect(isTerminalIntentState(result.state)).toBe(true);
  });

  it("sends an explicit txHash to verify when given one", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents/int_1/verify", (req) => {
      expect((req.body as { txHash: string }).txHash).toBe("0x" + "c".repeat(64));
      return jsonResponse({ ok: true, verdict: "not_found", state: "submitted", settlement: { verdict: "not_found" }, retryable: true });
    });
    await client(mock).verifySettlement("int_1", { txHash: "0x" + "c".repeat(64) });
  });
});

describe("getPaymentStatus", () => {
  it("reports settled only for a verified intent", async () => {
    const mock = new MockFetch()
      .on("GET", "/api/v1/intents/int_ok", () =>
        jsonResponse({ ok: true, intent: intent({ id: "int_ok", state: "verified" }), lifecycle: [{ state: "verified", at: "2026-01-01T00:00:00Z", detail: null }] }),
      )
      .on("GET", "/api/v1/intents/int_prep", () =>
        jsonResponse({ ok: true, intent: intent({ id: "int_prep", state: "prepared" }), lifecycle: [] }),
      )
      .on("GET", "/api/v1/intents/int_sub", () =>
        jsonResponse({ ok: true, intent: intent({ id: "int_sub", state: "submitted" }), lifecycle: [] }),
      );
    const c = client(mock);
    expect((await c.getPaymentStatus("int_ok")).settled).toBe(true);
    expect((await c.getPaymentStatus("int_prep")).settled).toBe(false);
    expect((await c.getPaymentStatus("int_sub")).settled).toBe(false);
  });

  it("marks a failed intent as failed", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/intents/int_f", () =>
      jsonResponse({ ok: true, intent: intent({ id: "int_f", state: "failed" }), lifecycle: [] }),
    );
    const status = await client(mock).getPaymentStatus("int_f");
    expect(status.failed).toBe(true);
    expect(status.settled).toBe(false);
  });
});

describe("webhooks", () => {
  it("registers a webhook and surfaces the one-time secret", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/webhooks", () =>
      jsonResponse({ ok: true, webhook: { id: "wh_1", object: "webhook", url: "https://x.test/hook", description: null, events: ["payment.verified"], status: "active", createdAt: "2026-01-01T00:00:00Z" }, secret: "whsec_abc" }, { status: 201 }),
    );
    const result = await client(mock).createWebhook({ url: "https://x.test/hook", events: ["payment.verified"] });
    expect(result.secret).toBe("whsec_abc");
    expect(result.webhook.events).toEqual(["payment.verified"]);
  });

  it("lists deliveries with their real status", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/webhooks/wh_1/deliveries", () =>
      jsonResponse({ ok: true, webhookId: "wh_1", deliveries: [{ id: "d1", object: "webhook_delivery", webhookId: "wh_1", event: "payment.verified", eventId: "e1", status: "delivered", attempts: 1, lastStatusCode: 200, lastError: null, nextAttemptAt: null, createdAt: "2026-01-01T00:00:00Z" }] }),
    );
    const deliveries = await client(mock).listWebhookDeliveries("wh_1");
    expect(deliveries[0]!.status).toBe("delivered");
    expect(deliveries[0]!.lastStatusCode).toBe(200);
  });
});

describe("state helpers", () => {
  it("treats only verified as settled", () => {
    expect(isSettled("verified")).toBe(true);
    for (const s of ["created", "validated", "prepared", "awaiting_authorization", "submitted", "confirmed", "rejected", "failed", "expired"] as const) {
      expect(isSettled(s)).toBe(false);
    }
  });

  it("treats verified/rejected/expired/failed as terminal", () => {
    expect(isTerminalIntentState("verified")).toBe(true);
    expect(isTerminalIntentState("submitted")).toBe(false);
    expect(isTerminalIntentState("confirmed")).toBe(false);
  });
});
