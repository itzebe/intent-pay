import { describe, expect, it } from "vitest";
import { IntentPay } from "../src/index.js";
import { ConfigurationError } from "../src/core/errors.js";
import { MockFetch, errorResponse, jsonResponse } from "./helpers.js";

const KEY = "ipk_live_abcdef123456.0123456789abcdef0123456789abcdef";

describe("configuration", () => {
  it("rejects a malformed API key before any request", () => {
    expect(() => new IntentPay({ apiKey: "not-a-key" })).toThrow(ConfigurationError);
  });

  it("accepts the documented key shapes", () => {
    expect(() => new IntentPay({ apiKey: KEY })).not.toThrow();
    expect(() => new IntentPay({ apiKey: "ipk_test_abc123.0123456789abcdef" })).not.toThrow();
  });

  it("normalizes a trailing slash off baseUrl", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/capabilities", () => jsonResponse({ ok: true, apiVersion: "v1" }));
    const client = new IntentPay({ baseUrl: "https://example.test/", fetch: mock.fetch });
    await client.getCapabilities();
    expect(mock.calls[0]!.url).toBe("https://example.test/api/v1/capabilities");
  });

  it("rejects a non-http baseUrl", () => {
    expect(() => new IntentPay({ baseUrl: "ftp://example.test" })).toThrow(ConfigurationError);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => new IntentPay({ timeoutMs: 0 })).toThrow(ConfigurationError);
  });

  it("rejects an out-of-range maxRetries", () => {
    expect(() => new IntentPay({ maxRetries: 99 })).toThrow(ConfigurationError);
  });

  it("requires a credential for authenticated calls, without a network round trip", async () => {
    const mock = new MockFetch();
    const client = new IntentPay({ fetch: mock.fetch });
    await expect(client.createIntent({ recipient: "0x1", receiveToken: "USDC", amount: "1" })).rejects.toMatchObject({
      code: "client_missing_credential",
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("never places the key in a URL or a query string", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/intents", () => jsonResponse({ ok: true, intents: [] }));
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch });
    await client.listIntents();
    expect(mock.calls[0]!.url).not.toContain("ipk_");
    expect(mock.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses a credential in a browser environment unless explicitly allowed", () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { document: {} };
    try {
      expect(() => new IntentPay({ apiKey: KEY })).toThrow(/Refusing to use an API key in a browser/);
      expect(() => new IntentPay({ apiKey: KEY, dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("allows the unauthenticated capabilities call with no credential", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/capabilities", () => jsonResponse({ ok: true }));
    const client = new IntentPay({ fetch: mock.fetch });
    await expect(client.getCapabilities()).resolves.toMatchObject({ ok: true });
  });
});

describe("capabilities", () => {
  it("surfaces the server's honest capability flags", async () => {
    const caps = {
      ok: true,
      apiVersion: "v1",
      network: { key: "mainnet", name: "Monad", chainId: 143, explorer: "https://monadscan.com" },
      networks: [{ key: "mainnet", chainId: 143 }],
      assets: [{ symbol: "MON", name: "Monad", address: "0x0", decimals: 18, native: true }],
      endpoints: [],
      intentStates: ["created"],
      webhookEvents: ["intent.created"],
      features: {
        frozenParameters: true,
        idempotencyKeys: true,
        independentVerification: true,
        webhookSigning: "hmac-sha256",
        webhookMaxAttempts: 6,
        credentialCanSign: false,
        keyCustody: false,
      },
      storage: { kind: "postgres", durability: "persistent", durable: true, reason: null },
      auth: { scheme: "bearer", header: "Authorization", testKeysAccepted: false, signup: "admin" },
    };
    const mock = new MockFetch().on("GET", "/api/v1/capabilities", () => jsonResponse(caps));
    const client = new IntentPay({ fetch: mock.fetch });
    const result = await client.getCapabilities();
    expect(result.network.chainId).toBe(143);
    expect(result.features.credentialCanSign).toBe(false);
    expect(result.features.keyCustody).toBe(false);
  });
});

describe("error mapping", () => {
  it("maps a server error envelope to a typed ApiError with its code", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/intents/abc", () =>
      errorResponse("not_found", "No such intent.", 404, { requestId: "req_1" }),
    );
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch });
    await expect(client.getIntent("abc")).rejects.toMatchObject({
      name: "ApiError",
      code: "not_found",
      status: 404,
      requestId: "req_1",
    });
  });

  it("marks a rate limit as retryable and a validation failure as not", async () => {
    const mock = new MockFetch()
      .on("GET", "/api/v1/intents/a", () => errorResponse("rate_limited", "Slow down.", 429))
      .on("GET", "/api/v1/intents/b", () => errorResponse("invalid_amount", "Bad amount.", 422));
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch, maxRetries: 0 });
    await expect(client.getIntent("a")).rejects.toMatchObject({ retryable: true });
    await expect(client.getIntent("b")).rejects.toMatchObject({ retryable: false });
  });

  it("does not leak a raw HTML body when the response is not JSON", async () => {
    const mock = new MockFetch().on("GET", "/api/v1/intents/x", () => new Response("<html>500</html>", { status: 500 }));
    const client = new IntentPay({ apiKey: KEY, fetch: mock.fetch, maxRetries: 0 });
    await expect(client.getIntent("x")).rejects.toMatchObject({ code: "internal_error", status: 500 });
  });
});
