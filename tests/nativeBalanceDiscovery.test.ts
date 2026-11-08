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

const { discoverWalletBalances } = await import("@/lib/server/discovery");

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
});
