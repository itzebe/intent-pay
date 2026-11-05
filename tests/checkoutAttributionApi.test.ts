import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, SqliteStore, setStore } from "@/lib/store";
import { createDeveloperWithKey } from "@/lib/developer/credentials";
import { derivePaymentAddress } from "@/lib/developer/xpub";

import { POST as attributionPOST, GET as attributionGET } from "@/app/api/v1/attribution/route";
import { POST as checkoutsPOST } from "@/app/api/v1/checkouts/route";
import { GET as checkoutGET } from "@/app/api/v1/checkouts/[id]/route";
import { GET as publicCheckoutGET } from "@/app/api/checkout/[token]/route";
import { POST as intentsPOST } from "@/app/api/v1/intents/route";

/**
 * Checkout-specific attribution through the real route handlers.
 *
 * These tests exercise the HTTP contract a merchant integrates against: register a
 * watch-only payment xpub, create an order, and see that the customer's payment
 * page points at a destination unique to that order. The store, the lifecycle,
 * the derivation and the binding are real; only the chain boundary (token
 * resolution, quote, encode) is mocked, exactly as `merchantCheckout.test.ts` does.
 */

const TEST_XPUB =
  "xpub6Ce9NcJvTk36xtLSrJLZqE7wtgA5deCeYs7rSQtreh4cj6ByPtrg9sD7V2FNFLPnf8heNP3FGkeV9qwfzvZNSd54JoNXVsXFYSYwHsnJxqP";
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
    encodeStep: vi.fn((step: { to: string; data?: string; value?: bigint }) => ({ to: step.to, data: step.data ?? "0x", value: step.value ?? 0n })),
  };
});

function req(url: string, opts: { method?: string; token?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(url, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

async function newKey(name = "Acme"): Promise<string> {
  const { issued } = await createDeveloperWithKey({ name });
  return issued.key;
}

async function createIntentViaApi(token: string): Promise<string> {
  const res = await intentsPOST(req("http://localhost/api/v1/intents", { method: "POST", token, body: { recipient: RECIPIENT, receiveToken: "USDC", amount: "5", amountMode: "recipient_receives" } }));
  return (await res.json()).intent.id;
}

beforeEach(() => {
  process.env.INTENT_PAY_DB_PATH = "/data/intent-pay.sqlite";
  setStore(new SqliteStore(":memory:"));
});
afterEach(() => {
  delete process.env.INTENT_PAY_DB_PATH;
  setStore(new MemoryStore());
  vi.clearAllMocks();
});

describe("attribution configuration API", () => {
  it("reports shared_recipient before an xpub is registered", async () => {
    const token = await newKey();
    const res = await attributionGET(req("http://localhost/api/v1/attribution", { token }));
    const json = await res.json();
    expect(json.attribution.mode).toBe("shared_recipient");
    expect(json.attribution.checkoutBound).toBe(false);
    expect(json.attribution.preview).toEqual([]);
  });

  it("enables checkout-bound attribution when an xpub is registered", async () => {
    const token = await newKey();
    const res = await attributionPOST(req("http://localhost/api/v1/attribution", { method: "POST", token, body: { paymentXpub: TEST_XPUB } }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.attribution.mode).toBe("checkout_bound");
    expect(json.attribution.preview).toHaveLength(3);
    expect(json.attribution.preview[0]).toBe(derivePaymentAddress(TEST_XPUB, 0));
  });

  it("never returns the xpub itself", async () => {
    const token = await newKey();
    await attributionPOST(req("http://localhost/api/v1/attribution", { method: "POST", token, body: { paymentXpub: TEST_XPUB } }));
    const res = await attributionGET(req("http://localhost/api/v1/attribution", { token }));
    const text = await res.text();
    expect(text).not.toContain(TEST_XPUB);
  });

  it("refuses a private key", async () => {
    const token = await newKey();
    const res = await attributionPOST(
      req("http://localhost/api/v1/attribution", { method: "POST", token, body: { paymentXpub: "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi" } }),
    );
    expect(res.status).toBe(400);
  });

  it("requires a credential", async () => {
    const res = await attributionGET(req("http://localhost/api/v1/attribution"));
    expect(res.status).toBe(401);
  });
});

describe("checkout-bound attribution end to end", () => {
  it("gives each order a unique destination the customer sees", async () => {
    const token = await newKey();
    await attributionPOST(req("http://localhost/api/v1/attribution", { method: "POST", token, body: { paymentXpub: TEST_XPUB } }));

    const intentId = await createIntentViaApi(token);
    const created = await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId, orderReference: "ORD-1" } }));
    const createdJson = await created.json();
    const dest0 = derivePaymentAddress(TEST_XPUB, 0);

    // The merchant sees the attribution mode.
    expect(createdJson.checkout.attribution.mode).toBe("checkout_bound");
    expect(createdJson.checkout.attribution.destination).toBe(dest0.toLowerCase());

    // The merchant's own view reports the destination as the effective recipient.
    const getRes = await checkoutGET(req(`http://localhost/api/v1/checkouts/${createdJson.checkout.id}`, { token }), { params: Promise.resolve({ id: createdJson.checkout.id }) });
    const got = await getRes.json();
    expect(got.intent.recipient).toBe(dest0.toLowerCase());

    // The customer's public view points at the same unique destination.
    const pubRes = await publicCheckoutGET(req(`http://localhost/api/checkout/${createdJson.token}`), { params: Promise.resolve({ token: createdJson.token }) });
    const pub = await pubRes.json();
    expect(pub.checkout.recipient).toBe(dest0.toLowerCase());
    expect(pub.checkout.attribution.mode).toBe("checkout_bound");
  });

  it("gives a second order a different destination", async () => {
    const token = await newKey();
    await attributionPOST(req("http://localhost/api/v1/attribution", { method: "POST", token, body: { paymentXpub: TEST_XPUB } }));

    const i1 = await createIntentViaApi(token);
    const c1 = await (await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId: i1 } }))).json();
    const i2 = await createIntentViaApi(token);
    const c2 = await (await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId: i2 } }))).json();

    expect(c1.checkout.attribution.destination).not.toBe(c2.checkout.attribution.destination);
    expect(c2.checkout.attribution.destination).toBe(derivePaymentAddress(TEST_XPUB, 1).toLowerCase());
  });

  it("keeps the shared recipient when no xpub is registered", async () => {
    const token = await newKey();
    const intentId = await createIntentViaApi(token);
    const created = await (await checkoutsPOST(req("http://localhost/api/v1/checkouts", { method: "POST", token, body: { intentId } }))).json();
    expect(created.checkout.attribution.mode).toBe("shared_recipient");
    expect(created.checkout.attribution.destination).toBeNull();
  });
});
