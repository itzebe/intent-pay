import { describe, expect, it, beforeAll } from "vitest";
import { parseAbi, type Address } from "viem";
import { UniswapV3Provider } from "@/lib/providers/uniswapV3";
import { getToken, poolAddressOf, type TokenConfig } from "@/lib/config/tokens";
import { ensureCatalog } from "@/lib/server/discovery";
import { FEE_TIERS, UNISWAP } from "@/lib/providers/constants";
import { getPublicClient } from "@/lib/server/rpc";

/**
 * Live integration tests against real Monad mainnet.
 *
 * These are gated because they hit the network. Run with:
 *
 *   MONAD_LIVE_TESTS=1 npx vitest run tests/liveRouting.test.ts
 *
 * They lock in the routing behaviour verified in the T7 fix (QuoterV2 revert
 * decoding via Multicall3, all fee tiers probed, graph reuse) and prove that a
 * token discovered at runtime is routable — the point of this change.
 */
const LIVE = process.env.MONAD_LIVE_TESTS === "1";
const network = "mainnet" as const;

const provider = new UniswapV3Provider("mainnet");

async function quote(pay: string, receive: string, usd = "5") {
  const res = await provider.quote({
    payToken: getToken(pay)!,
    receiveToken: getToken(receive)!,
    mode: "recipient_receives",
    amount: usd,
    usd: true,
    network,
  });
  return res;
}

/** Exact-input quote ("I spend") — a fixed token amount in, quoted out. */
async function quoteIn(pay: string, receive: string, amount: string) {
  const res = await provider.quote({
    payToken: getToken(pay)!,
    receiveToken: getToken(receive)!,
    mode: "i_spend",
    amount,
    usd: false,
    network,
  });
  return res;
}

/**
 * Independent market precondition for the `cbBTC -> USDC` exact-output route.
 *
 * The route only exists as the multi-hop `cbBTC -> EURW -> USDC`, so both hops
 * must have a pool with positive active liquidity. This reads the V3 factory
 * and each pool's `liquidity()` directly — it does NOT use the quote under test
 * (a quote that fails for any reason, including an empty pool, must never be
 * its own precondition). Any RPC failure propagates as a thrown error so the
 * test can fail loudly instead of mistaking an infrastructure problem for
 * absent liquidity.
 */
const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Deepest active liquidity for a pair across every configured fee tier. */
async function deepestLiquidity(a: TokenConfig, b: TokenConfig): Promise<bigint> {
  const client = getPublicClient(network);
  let best = 0n;
  for (const fee of FEE_TIERS) {
    const pool = (await client.readContract({
      address: UNISWAP.v3Factory as Address,
      abi: FACTORY_ABI,
      functionName: "getPool",
      args: [poolAddressOf(a) as Address, poolAddressOf(b) as Address, fee],
    })) as Address;
    if (!pool || pool.toLowerCase() === ZERO_ADDRESS) continue;
    const liq = (await client.readContract({
      address: pool,
      abi: POOL_ABI,
      functionName: "liquidity",
    })) as bigint;
    if (liq > best) best = liq;
  }
  return best;
}

describe.skipIf(!LIVE)("live routing on Monad mainnet (chain 143)", () => {
  beforeAll(async () => {
    // Mirror production: install the runtime catalog from the live Monad list
    // before routing. Production calls ensureCatalog on every API request; an
    // isolated test must do the same or the bounded route graph cannot discover
    // intermediates that only exist in the list (e.g. cbBTC -> EURW -> USDC).
    await ensureCatalog("mainnet");
    // Warm the graph once so the suite is not dominated by discovery.
    await provider.availableSymbols();
  }, 180_000);

  it("USDT -> USDC quotes with a real route", async () => {
    const res = await quote("USDT", "USDC");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.payAmount)).toBeGreaterThan(0);
    expect(res.receiveAmount).toBe("5");
    expect(res.route.path[0]).toBe("USDT");
    expect(res.route.path.at(-1)).toBe("USDC");
  }, 120_000);

  it("USDC -> MON quotes (native MON handling)", async () => {
    const res = await quote("USDC", "MON");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("MON -> USDT quotes (native MON input)", async () => {
    const res = await quote("MON", "USDT");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("cbBTC -> USDC quotes", async ({ skip }) => {
    // Market precondition (Issue #11): the cbBTC -> USDC route is only reachable
    // as cbBTC -> EURW -> USDC, so both hops need a pool with active liquidity.
    // This is probed independently of the quote under test; a genuinely empty
    // market is skipped, while an RPC failure fails the test below.
    const cbbtc = getToken("cbBTC");
    const eurw = getToken("EURW");
    const usdc = getToken("USDC");
    if (!cbbtc || !eurw || !usdc) {
      const missing = [!cbbtc && "cbBTC", !eurw && "EURW", !usdc && "USDC"].filter(Boolean).join(", ");
      throw new Error(
        `cbBTC -> USDC live test: the runtime catalog did not resolve ${missing}; ` +
          "the required route cannot be evaluated.",
      );
    }

    let cbbtcEurw: bigint;
    let eurwUsdc: bigint;
    try {
      cbbtcEurw = await deepestLiquidity(cbbtc, eurw);
      eurwUsdc = await deepestLiquidity(eurw, usdc);
    } catch (err) {
      // An RPC/infrastructure error is NOT evidence of zero liquidity.
      throw new Error(
        `cbBTC -> USDC live test: could not read pool liquidity to establish the market ` +
          `precondition (RPC or contract-call failure, not a liquidity outcome): ${(err as Error)?.message}`,
      );
    }

    if (cbbtcEurw <= 0n || eurwUsdc <= 0n) {
      const hop = cbbtcEurw <= 0n ? "cbBTC -> EURW" : "EURW -> USDC";
      const liq = cbbtcEurw <= 0n ? cbbtcEurw : eurwUsdc;
      // The supported Vitest `skip()` takes no reason argument; log it first so
      // the skip is self-explanatory in the run output.
      console.info(
        `[live-routing] SKIP cbBTC -> USDC: required hop ${hop} has no pool with active ` +
          `liquidity on Monad mainnet (deepest liquidity = ${liq} across fee tiers ` +
          `${FEE_TIERS.join("/")}). This is a market condition, not a routing defect.`,
      );
      skip();
      return;
    }

    const res = await quote("cbBTC", "USDC");
    // Both hops are liquid, so a failure here is a real routing problem.
    expect(
      res.ok,
      res.ok
        ? ""
        : `cbBTC -> USDC failed with "${res.code}" although both hops report active liquidity ` +
          `(cbBTC->EURW=${cbbtcEurw}, EURW->USDC=${eurwUsdc}): ${res.message}`,
    ).toBe(true);
    if (!res.ok) return;
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("a token discovered at runtime is routable (regression: tokenByKey)", async () => {
    // DUST is in the official list but not a shipped seed, and its only pool is
    // thin — so quote a size its liquidity supports. The point is that the
    // path search can now *reach* a discovered token at all.
    const res = await quote("DUST", "USDC", "0.01");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path[0]).toBe("DUST");
    expect(res.route.path).toContain("USDC");
  }, 120_000);

  it("preserves the exact recipient amount (exact-output intent)", async () => {
    const res = await quote("USDT", "USDC", "5");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receiveAmount).toBe("5");
  }, 120_000);

  it("alternatives are reachable from the pay token, not merely liquid", async () => {
    // DUST is reachable from USDT (via USDC) but a $5 exact-output quote exceeds
    // its thin liquidity, so this is a route_unavailable. The alternatives must
    // be tokens the sender can actually pay from USDT — never the receive token
    // itself, and never a token that is only liquid somewhere unrelated.
    const res = await quote("USDT", "DUST", "5");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("route_unavailable");
    expect(res.alternatives).toBeTruthy();
    expect(res.alternatives).not.toContain("DUST");
    expect(res.alternatives).toContain("USDC");
  }, 120_000);

  it("multi-hop exact output preserves the recipient amount (regression: forward-quote bug)", async () => {
    // WETH -> MON has no direct pool; it must route WETH -> USDC -> MON. The old
    // path search quoted the *forward* hop with the final MON amount (18-dp)
    // against USDC (6-dp), so this valid route looked unavailable.
    const res = await quote("WETH", "MON", "10");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path[0]).toBe("WETH");
    expect(res.route.path.at(-1)).toBe("MON");
    expect(res.route.path.length).toBeGreaterThan(2); // genuinely multi-hop
    expect(Number(res.receiveAmount)).toBeGreaterThan(0);
    expect(Number(res.payAmount)).toBeGreaterThan(0);
  }, 120_000);

  it("does not substitute the requested output asset", async () => {
    // The requested output asset is authoritative: even though the route passes
    // through USDC, the recipient receives MON — never USDC.
    const res = await quote("WETH", "MON", "10");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path.at(-1)).toBe("MON");
    expect(res.route.hops.at(-1)?.toSymbol).toBe("MON");
  }, 120_000);

  it("exact-input picks the best pool, not the worst (regression: ascending sort)", async () => {
    // The forward (exact-in) search must rank goals by the most output. It
    // previously sorted ascending, so USDC→MON chose the fee=100 tier
    // (~2.86 MON per 1 USDC) over the deeper fee=3000 tier (~38.8 MON), a >10x
    // shortfall. A sound quote must deliver at least 10 MON for 1 USDC.
    const res = await quoteIn("USDC", "MON", "1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receiveAmount).not.toBe("");
    expect(Number(res.receiveAmount)).toBeGreaterThan(10);
    // The reported human rate (receive per 1 pay) must be decimal-adjusted.
    // USDC is 6-dp and MON is 18-dp, so a raw-base-unit rate would be inflated
    // by 10^12 (≈3.9e13 instead of ≈38.8).
    expect(res.rate).toBeGreaterThan(0);
    expect(res.rate).toBeLessThan(1000);
  }, 120_000);
});
