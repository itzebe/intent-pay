import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Address } from "viem";

/**
 * Native MON must be discovered even when the ERC-20 multicall rate-limits.
 *
 * The owner-reported failure: a wallet holding a large MON balance was shown as
 * holding none, so a native MON payment was impossible ("no executable payment
 * asset") and a token payment that needs MON for gas was falsely blocked.
 *
 * Root cause: `discoverWalletBalances` read the native MON balance with
 * `client.getBalance` *after* the ~120-call `balanceOf` multicall. Monad's
 * keyless public RPC answers a burst of reads with HTTP 429 (it clears within a
 * second), and the trailing native read was the read that got throttled. The
 * failure was swallowed by `catch { /* ignore *\/ }`, so the wallet looked empty.
 *
 * These tests drive the real discovery code path with a controlled client, so
 * they assert the *order* and the *resilience* that fix the defect — not a stub.
 */

const getBalance = vi.fn();
const multicall = vi.fn();
const order: string[] = [];

vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({
    getBalance: (...args: unknown[]) => {
      order.push("getBalance");
      return getBalance(...args);
    },
    multicall: (...args: unknown[]) => {
      order.push("multicall");
      return multicall(...args);
    },
  }),
}));

const { discoverWalletBalances, withRateLimitRetry } = await import("@/lib/server/discovery");

const WALLET = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address;
/** A realistic native holding (a Monad whale). */
const MON_WEI = 375_000_000n * 10n ** 18n;

/** One non-zero ERC-20 result so the multicall path is exercised too. */
const erc20Hit = [
  { status: "success" as const, result: 1238_743588n },
];

const priceOf = async () => ({ usd: 1, source: "test" });

beforeEach(() => {
  getBalance.mockReset();
  multicall.mockReset();
  order.length = 0;
});

describe("native MON discovery", () => {
  it("reads native MON BEFORE the ERC-20 multicall (the rate-limit window)", async () => {
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue(erc20Hit);

    await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    // The native read must come first: after the multicall the public RPC has
    // rate-limited the caller and the native read is rejected with 429.
    expect(order[0]).toBe("getBalance");
    expect(order).toContain("multicall");
    expect(order.indexOf("getBalance")).toBeLessThan(order.indexOf("multicall"));
  });

  it("includes the native MON balance in the result", async () => {
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue([]);

    const { balances } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    const mon = balances.find((b) => b.token.native);
    expect(mon).toBeDefined();
    expect(mon!.token.symbol).toBe("MON");
    expect(mon!.amount).toBe("375000000");
    expect(mon!.raw).toBe(MON_WEI);
  });

  it("retries a transient rate-limited native read and still reports MON", async () => {
    // First attempt is throttled (429), the retry succeeds — the observed
    // production behaviour of the public Monad RPC.
    getBalance.mockRejectedValueOnce(new Error("HTTP request failed. Status: 429")).mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue([]);

    const { balances } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    expect(getBalance).toHaveBeenCalledTimes(2);
    expect(balances.some((b) => b.token.native)).toBe(true);
  });

  it("omits native MON (never fabricates a zero) when every read fails", async () => {
    getBalance.mockRejectedValue(new Error("HTTP request failed. Status: 429"));
    multicall.mockResolvedValue(erc20Hit);

    const { balances } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    // Honest: no MON entry at all — a fabricated 0 would look like an empty
    // wallet and block a payment that is actually affordable.
    expect(balances.some((b) => b.token.native)).toBe(false);
    // The ERC-20 path is unaffected.
    expect(balances.length).toBeGreaterThan(0);
  });

  it("does not drop the ERC-20 balances when native MON is read", async () => {
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue(erc20Hit);

    const { balances } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    expect(balances.some((b) => b.token.native)).toBe(true);
    expect(balances.some((b) => !b.token.native)).toBe(true);
  });

  it("retries a throttled ERC-20 multicall instead of reporting an empty wallet", async () => {
    getBalance.mockResolvedValue(MON_WEI);
    // The ~120-call batch is a burst the public RPC can 429; the retry recovers
    // the holdings rather than showing a wallet with no tokens.
    multicall
      .mockRejectedValueOnce(new Error("HTTP request failed. Status: 429"))
      .mockResolvedValue(erc20Hit);

    const { balances } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    expect(multicall).toHaveBeenCalledTimes(2);
    expect(balances.some((b) => !b.token.native)).toBe(true);
  });

  it("de-duplicates concurrent discovery for the same address into ONE on-chain read", async () => {
    // A page load fires several balance reads for the same address at once.
    // Without de-duplication each one re-issues the ~120-call burst, multiplying
    // the RPC load by the concurrency — which is what made the endpoint answer
    // `count: 0` (everything throttled) or hang past the serverless timeout.
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue(erc20Hit);

    const [a, b, c] = await Promise.all([
      discoverWalletBalances(WALLET, "mainnet", priceOf, []),
      discoverWalletBalances(WALLET, "mainnet", priceOf, []),
      discoverWalletBalances(WALLET, "mainnet", priceOf, []),
    ]);

    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(multicall).toHaveBeenCalledTimes(1);
    // Every caller gets the same real result.
    for (const r of [a, b, c]) {
      expect(r.balances.some((x) => x.token.native)).toBe(true);
    }
  });

  it("does a fresh read for the next request after the in-flight one settles", async () => {
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue(erc20Hit);

    await discoverWalletBalances(WALLET, "mainnet", priceOf, []);
    await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    // No stale cache: each settled request performs its own read.
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it("reports the result as incomplete when the token batch cannot be read", async () => {
    // Every read of the token batch fails. The wallet's token holdings are then
    // UNKNOWN, not empty — the API must say so, or a funded wallet is rendered
    // as "holds nothing" and the payment is blocked.
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockRejectedValue(new Error("HTTP request failed. Status: 429"));

    const { balances, partial } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    expect(partial).toBe(true);
    // The native read still succeeded and is reported honestly.
    expect(balances.some((b) => b.token.native)).toBe(true);
  });

  it("reports a fully-read wallet as complete", async () => {
    getBalance.mockResolvedValue(MON_WEI);
    multicall.mockResolvedValue(erc20Hit);

    const { partial } = await discoverWalletBalances(WALLET, "mainnet", priceOf, []);

    expect(partial).toBe(false);
  });
});

describe("rate-limit retry policy", () => {
  // The public Monad RPC's 429 window is ~2s. A retry that fires sooner than
  // that re-hits the limit and the read is abandoned — the exact reason a funded
  // wallet was reported empty. The default backoff must therefore outlast it.
  it("waits longer than the public RPC's ~2s rate-limit window before giving up", async () => {
    vi.useFakeTimers();
    try {
      const attempts: number[] = [];
      const read = vi.fn().mockImplementation(async () => {
        attempts.push(Date.now());
        throw new Error("HTTP request failed. Status: 429");
      });
      const promise = withRateLimitRetry(read);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
      expect(attempts).toHaveLength(3);
      // The last retry must fire after the ~2s window, or it re-hits the limit.
      const elapsed = attempts[attempts.length - 1] - attempts[0];
      expect(elapsed).toBeGreaterThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops as soon as a retry succeeds", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValueOnce(42n);

    const result = await withRateLimitRetry(read, [1]);

    expect(result).toBe(42n);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
