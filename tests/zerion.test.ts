import { describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchZerionAssets,
  fetchZerionResult,
  tokenFromZerion,
  zerionEnabled,
} from "@/lib/server/zerion";

// A fresh wallet per test: the adapter caches by address for 30s.
let n = 0;
function freshWallet(): string {
  n += 1;
  return `0x${n.toString(16).padStart(40, "0")}`;
}

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

/** Real-shaped Zerion positions payload for Monad, using the actual USDC address. */
const PAYLOAD = {
  data: [
    {
      attributes: {
        quantity: { numeric: "18.42", decimals: 6 },
        value: 18.42,
        price: 1.0,
        fungible_info: {
          symbol: "USDC",
          name: "USDC",
          icon: { url: "https://example.test/usdc.png" },
          flags: { verified: true },
          implementations: [
            { chain_id: "monad", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 },
          ],
        },
      },
      relationships: { chain: { data: { id: "monad" } } },
    },
    {
      attributes: {
        quantity: { numeric: "0.5", decimals: 18 },
        value: 3.2,
        price: 6.4,
        fungible_info: {
          symbol: "WMON",
          name: "Wrapped MON",
          flags: { verified: false },
          implementations: [
            { chain_id: "monad", address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", decimals: 18 },
          ],
        },
      },
    },
    {
      // Wrong chain — must be ignored.
      attributes: {
        quantity: { numeric: "1", decimals: 18 },
        value: 1,
        fungible_info: {
          symbol: "FAKE",
          name: "Wrong Chain",
          implementations: [
            { chain_id: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 18 },
          ],
        },
      },
    },
  ],
};

describe("Zerion wallet intelligence", () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
    delete process.env.ZERION_API_KEY;
    delete process.env.ZERION_ENABLED;
    vi.restoreAllMocks();
  });

  it("is disabled without a key", async () => {
    expect(zerionEnabled()).toBe(false);
    global.fetch = vi.fn();
    const assets = await fetchZerionAssets(freshWallet());
    expect(assets).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("normalizes Monad positions and drops other chains", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = mockFetch(200, PAYLOAD);
    const assets = await fetchZerionAssets(freshWallet());
    expect(assets.map((a) => a.symbol)).toEqual(["USDC", "WMON"]);
    expect(assets[0]).toMatchObject({ amount: "18.42", usd: 18.42, verified: true, decimals: 6 });
    expect(assets[1].verified).toBe(false);
  });

  it("returns [] on a failed request (never a fabricated empty wallet)", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = mockFetch(401, { errors: [] });
    const assets = await fetchZerionAssets(freshWallet());
    expect(assets).toEqual([]);
  });

  it("reports a provider failure as status 'error', not an empty wallet", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = mockFetch(401, { errors: [] });
    const res = await fetchZerionResult(freshWallet());
    expect(res.status).toBe("error");
    expect(res.assets).toEqual([]);
    expect(res.reason).toMatch(/401/);
  });

  it("reports 'disabled' (not 'error') when unconfigured", async () => {
    global.fetch = vi.fn();
    const res = await fetchZerionResult(freshWallet());
    expect(res.status).toBe("disabled");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports 'ok' with an authoritative (possibly empty) list on success", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = mockFetch(200, { data: [] });
    const res = await fetchZerionResult(freshWallet());
    expect(res.status).toBe("ok");
    expect(res.assets).toEqual([]);
  });

  it("treats a network throw as status 'error', not 'disabled'", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const res = await fetchZerionResult(freshWallet());
    expect(res.status).toBe("error");
  });

  it("registers a normalized asset as a payable token", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = mockFetch(200, PAYLOAD);
    const [usdc] = await fetchZerionAssets(freshWallet());
    const token = tokenFromZerion(usdc);
    expect(token.symbol).toBe("USDC");
    expect(token.address.toLowerCase()).toBe(
      "0x754704bc059f8c67012fed69bc8a327a5aafb603",
    );
  });

  it("never downgrades a curated token with wallet-supplied metadata", async () => {
    process.env.ZERION_API_KEY = "zk_test";
    global.fetch = mockFetch(200, PAYLOAD);
    const [usdc] = await fetchZerionAssets(freshWallet());
    // USDC ships in the curated seed list; a wallet record must not overwrite it.
    const token = tokenFromZerion({ ...usdc, name: "Sketchy USD Coin", decimals: 2 });
    expect(token.source).toBe("seed");
    expect(token.name).not.toBe("Sketchy USD Coin");
  });
});
