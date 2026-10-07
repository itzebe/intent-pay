import { describe, expect, it, vi, afterEach } from "vitest";
import { getMarketPriceUsd } from "@/lib/server/pricing/market";
import { GeckoTerminalPriceProvider } from "@/lib/server/pricing/geckoTerminal";
import { DexScreenerPriceProvider } from "@/lib/server/pricing/dexscreener";
import { AlchemyPriceProvider } from "@/lib/server/pricing/alchemyPrice";
import { getToken, type TokenConfig } from "@/lib/config/tokens";

const USDC = getToken("USDC")!;

// Providers keep a shared TTL cache keyed by pool address (correct in prod).
// Tests get a fresh address each time so each call actually hits the network.
let n = 0;
function freshToken(): TokenConfig {
  n += 1;
  const hex = n.toString(16).padStart(40, "0");
  return { ...USDC, address: `0x${hex}` as `0x${string}` };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("market price providers (real response shapes)", () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
    delete process.env.ALCHEMY_API_KEY;
    vi.restoreAllMocks();
  });

  it("GeckoTerminal reads price_usd and trusts a deep pool", async () => {
    global.fetch = mockFetch(200, {
      data: { attributes: { price_usd: "1.0002", total_reserve_in_usd: "4500000" } },
    });
    const p = new GeckoTerminalPriceProvider();
    const usd = await p.price({ network: "mainnet", token: USDC, poolAddress: freshToken().address });
    expect(usd).toBeCloseTo(1.0002, 4);
  });

  it("GeckoTerminal refuses a shallow pool rather than mispricing", async () => {
    global.fetch = mockFetch(200, {
      data: { attributes: { price_usd: "0.0001", total_reserve_in_usd: "10" } },
    });
    const p = new GeckoTerminalPriceProvider();
    const usd = await p.price({ network: "mainnet", token: USDC, poolAddress: freshToken().address });
    expect(usd).toBeNull();
  });

  it("DexScreener picks the deepest pair", async () => {
    global.fetch = mockFetch(200, [
      { priceUsd: "0.02", liquidity: { usd: 500 } },
      { priceUsd: "0.0242", liquidity: { usd: 120000 } },
    ]);
    const p = new DexScreenerPriceProvider();
    const usd = await p.price({ network: "mainnet", token: USDC, poolAddress: freshToken().address });
    expect(usd).toBeCloseTo(0.0242, 6);
  });

  it("Alchemy is disabled without a key and enabled with one", async () => {
    const p = new AlchemyPriceProvider();
    expect(p.enabled("mainnet")).toBe(false);
    process.env.ALCHEMY_API_KEY = "test-key";
    expect(p.enabled("mainnet")).toBe(true);
    global.fetch = mockFetch(200, {
      data: [{ prices: [{ currency: "USD", value: "1.0" }] }],
    });
    const usd = await p.price({ network: "mainnet", token: USDC, poolAddress: freshToken().address });
    expect(usd).toBe(1);
  });

  it("returns null on a non-200 so the resolver falls through", async () => {
    global.fetch = mockFetch(500, {});
    const p = new GeckoTerminalPriceProvider();
    const usd = await p.price({ network: "mainnet", token: USDC, poolAddress: freshToken().address });
    expect(usd).toBeNull();
  });

  it("getMarketPriceUsd falls through to DexScreener when GeckoTerminal fails", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) } as any;
      return {
        ok: true,
        status: 200,
        json: async () => [{ priceUsd: "1.01", liquidity: { usd: 999999 } }],
      } as any;
    }) as unknown as typeof fetch;
    const result = await getMarketPriceUsd(freshToken(), "mainnet");
    expect(result?.source).toBe("dex");
    expect(result?.usd).toBeCloseTo(1.01, 4);
  });
});
