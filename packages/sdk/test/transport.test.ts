import { describe, expect, it, vi } from "vitest";
import { IntentPay } from "../src/index.js";
import { backoffDelay, parseRetryAfter, shouldRetry } from "../src/core/transport.js";
import { ApiError, TransportError } from "../src/core/errors.js";
import { MockFetch, errorResponse, failingFetch, hangingFetch, jsonResponse } from "./helpers.js";

const KEY = "ipk_live_abcdef123456.0123456789abcdef0123456789abcdef";

describe("shouldRetry", () => {
  const base = { attempt: 0, maxRetries: 2 };

  it("retries a 429, a 408 and any 5xx", () => {
    expect(shouldRetry({ ...base, status: 429 })).toBe(true);
    expect(shouldRetry({ ...base, status: 408 })).toBe(true);
    expect(shouldRetry({ ...base, status: 503 })).toBe(true);
  });

  it("does not retry a 4xx client error", () => {
    expect(shouldRetry({ ...base, status: 400 })).toBe(false);
    expect(shouldRetry({ ...base, status: 404 })).toBe(false);
    expect(shouldRetry({ ...base, status: 422 })).toBe(false);
  });

  it("stops once the retry budget is spent", () => {
    expect(shouldRetry({ attempt: 2, maxRetries: 2, status: 500 })).toBe(false);
  });

  it("retries an idempotent timeout but never a non-idempotent one", () => {
    expect(shouldRetry({ ...base, timedOut: true })).toBe(true);
    expect(shouldRetry({ ...base, timedOut: true, nonIdempotent: true })).toBe(false);
  });

  it("retries a non-idempotent request only when it never reached the server", () => {
    expect(shouldRetry({ ...base, neverReachedServer: true, nonIdempotent: true })).toBe(true);
  });

  it("retries a non-idempotent request that carries an idempotency key", () => {
    expect(shouldRetry({ ...base, timedOut: true, nonIdempotent: true, idempotencyKey: "k1" })).toBe(true);
  });
});

describe("backoff and Retry-After", () => {
  it("honors a Retry-After value and caps it", () => {
    expect(backoffDelay(1, 5_000)).toBe(5_000);
    expect(backoffDelay(1, 999_999)).toBe(30_000);
  });

  it("produces a bounded, jittered delay without Retry-After", () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(8_000);
    }
  });

  it("parses seconds and an HTTP date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter(new Date(now + 5_000).toUTCString(), now)).toBe(5_000);
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe("transport retries in practice", () => {
  it("retries a 503 and then succeeds", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/intents", (_req, attempt) =>
      attempt < 3 ? errorResponse("provider_error", "Upstream hiccup.", 503) : jsonResponse({ ok: true, intents: [] }),
    );
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch, maxRetries: 2 });
    await expect(client.listIntents()).resolves.toEqual([]);
    expect(mock.calls).toHaveLength(3);
  });

  it("gives up after the budget and throws the last error", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/intents", () => errorResponse("provider_error", "Down.", 503));
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch, maxRetries: 1 });
    await expect(client.listIntents()).rejects.toBeInstanceOf(ApiError);
    expect(mock.calls).toHaveLength(2);
  });

  it("retries a connection error that never reached the server", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 2) {
        const err = new Error("fetch failed");
        throw err;
      }
      return jsonResponse({ ok: true, intents: [] });
    }) as unknown as typeof fetch;
    const client = new IntentPay({ apiKey: KEY, fetch: fetchImpl, maxRetries: 2 });
    await expect(client.listIntents()).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not retry a submit that timed out (the tx may already exist)", async () => {
    let calls = 0;
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
    }) as unknown as typeof fetch;
    const client = new IntentPay({ apiKey: KEY, fetch: fetchImpl, maxRetries: 3, timeoutMs: 20 });
    await expect(client.submitTransaction("i1", { txHash: "0x" + "a".repeat(64) })).rejects.toMatchObject({ code: "transport_timeout" });
    expect(calls).toBe(1);
  });

  it("reports a timeout as a TransportError with the path", async () => {
    const client = new IntentPay({ apiKey: KEY, fetch: hangingFetch(), timeoutMs: 20, maxRetries: 0 });
    await expect(client.getIntent("i1")).rejects.toMatchObject({ name: "TransportError", code: "transport_timeout" });
  });

  it("throws a TransportError for a network failure with no retries left", async () => {
    const client = new IntentPay({ apiKey: KEY, fetch: failingFetch(new Error("ECONNREFUSED")), maxRetries: 0 });
    await expect(client.getIntent("i1")).rejects.toBeInstanceOf(TransportError);
  });

  it("keeps a request bounded by the timeout", async () => {
    const client = new IntentPay({ apiKey: KEY, fetch: hangingFetch(), timeoutMs: 20, maxRetries: 0 });
    const started = Date.now();
    await expect(client.getIntent("i1")).rejects.toBeInstanceOf(TransportError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("idempotency", () => {
  it("sends the Idempotency-Key header and the body field on create", async () => {
    const mock = new MockFetch().on("POST", "/api/v1/intents", () =>
      jsonResponse({ ok: true, created: true, intent: sampleIntent() }, { status: 201 }),
    );
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch });
    await client.createIntent({ recipient: "0xabc", receiveToken: "USDC", amount: "5", idempotencyKey: "order-123" });
    const req = mock.calls[0]!;
    expect(req.headers["idempotency-key"]).toBe("order-123");
    expect((req.body as { idempotencyKey: string }).idempotencyKey).toBe("order-123");
  });

  it("retries a timed-out create because the key makes it safe", async () => {
    let calls = 0;
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        });
      }
      return jsonResponse({ ok: true, created: false, intent: sampleIntent() }, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new IntentPay({ apiKey: KEY, fetch: fetchImpl, maxRetries: 2, timeoutMs: 20 });
    const result = await client.createIntent({ recipient: "0xabc", receiveToken: "USDC", amount: "5", idempotencyKey: "order-1" });
    expect(result.created).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("isRetryable / isAmbiguousSubmission", () => {
  it("classifies a provider_error as both retryable and ambiguous", async () => {
    const { isRetryable, isAmbiguousSubmission } = await import("../src/core/errors.js");
    const err = new ApiError("provider_error", "x", { status: 502 });
    expect(isRetryable(err)).toBe(true);
    expect(isAmbiguousSubmission(err)).toBe(true);
  });

  it("never calls a validation error ambiguous", async () => {
    const { isAmbiguousSubmission } = await import("../src/core/errors.js");
    expect(isAmbiguousSubmission(new ApiError("invalid_amount", "x", { status: 422 }))).toBe(false);
  });
});

function sampleIntent() {
  return {
    id: "int_1",
    object: "intent",
    state: "created",
    chainId: 143,
    recipient: "0xabc",
    receiveToken: "USDC",
    receiveTokenAddress: "0x7547",
    amountMode: "recipient_receives",
    amount: "5",
    payToken: null,
    reference: null,
    authorized: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

void vi;
