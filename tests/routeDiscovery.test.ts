import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, type Address } from "viem";

/**
 * Deterministic route-discovery regressions (Issue #11).
 *
 * The live `cbBTC -> USDC` test went red because cbBTC's Monad pools currently
 * hold zero active liquidity — a market fact, not a routing defect. These tests
 * pin the *code* behaviour that makes that outcome correct, with the RPC layer
 * mocked so they never depend on Monad liquidity:
 *
 *   1. a pool with zero active liquidity is excluded from the routing graph,
 *   2. a token whose only pools are empty cannot be reached by the backward
 *      exact-output search, so the quote is `route_unavailable`,
 *   3. a genuinely liquid multi-hop exact-output route still quotes (the
 *      positive case the live test is meant to prove),
 *   4. an RPC failure during discovery degrades to `route_unavailable` — it is
 *      never thrown and never mistaken for a crash.
 *
 * The zero-liquidity-vs-infrastructure distinction that the *live* test needs is
 * enforced in `tests/liveRouting.test.ts`, which probes pool liquidity directly
 * and treats a thrown RPC error as a test failure (see that file).
 */

const readContract = vi.fn();
const call = vi.fn();

vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({ readContract, call }),
}));

const { UniswapV3Provider } = await import("@/lib/providers/uniswapV3");
const { registerToken, getToken } = await import("@/lib/config/tokens");

/** Mirrors the provider's own quoter/factory/pool ABIs (test-local, no prod import). */
const ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function liquidity() view returns (uint128)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amountOut, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

// Real curated addresses, so the fixture exercises the same keys production uses.
const CBTC = "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b" as Address;
const EURW = "0x1111b3ded9f1fe1801ad4ebef8e2788183a24111" as Address;
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603" as Address;

/** A stable, non-zero pool address derived from the pair+fee (fixture only). */
function fakePool(addrA: string, addrB: string, fee: number): Address {
  // Lowercase before sorting: the provider passes checksummed addresses to
  // getPool but lowercases everywhere else, so both call sites must agree.
  const seed = [addrA.toLowerCase(), addrB.toLowerCase()].sort().join(":") + ":" + fee;
  let h = 0n;
  for (const ch of seed) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 160n);
  return ("0x" + h.toString(16).padStart(40, "0")) as Address;
}

function encodeAddress(a: string): string {
  return encodeAbiParameters(parseAbiParameters("address"), [a as Address]);
}
function encodeUint(n: bigint): string {
  return encodeAbiParameters(parseAbiParameters("uint256"), [n]);
}
/** QuoterV2 returns (amount, sqrtPriceX96After, initializedTicksCrossed, gasEstimate). */
function encodeQuote(amount: bigint): string {
  return encodeAbiParameters(parseAbiParameters("uint256,uint160,uint32,uint256"), [amount, 0n, 0, 0n]);
}

type Fixture = {
  /** `${addrA}|${addrB}|${fee}` (addresses lowercased, sorted) -> active liquidity. */
  pools: Map<string, bigint>;
  /** `${tokenIn}|${tokenOut}|${fee}` -> amountIn required (exact-output quote). */
  exactOut: Map<string, bigint>;
  /** `${tokenIn}|${tokenOut}|${fee}` -> amountOut (exact-input quote). */
  exactIn: Map<string, bigint>;
  /** When true every RPC read throws (infrastructure failure). */
  rpcFails: boolean;
};

function emptyFixture(): Fixture {
  return { pools: new Map(), exactOut: new Map(), exactIn: new Map(), rpcFails: false };
}

const poolKey = (a: string, b: string, fee: number) =>
  [a.toLowerCase(), b.toLowerCase()].sort().join("|") + "|" + fee;
const hopKey = (a: string, b: string, fee: number) =>
  [a.toLowerCase(), b.toLowerCase()].join("|") + "|" + fee;

let fixture: Fixture = emptyFixture();

function handleAggregate(slice: { target: string; callData: string }[]) {
  return slice.map((c) => {
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({
        abi: ABI,
        data: c.callData as `0x${string}`,
      }) as unknown as { functionName: string; args: readonly unknown[] };
    } catch {
      return { success: false, returnData: "0x" };
    }
    if (decoded.functionName === "getPool") {
      const [a, b, fee] = decoded.args as [string, string, number];
      const liq = fixture.pools.get(poolKey(a, b, Number(fee)));
      if (liq === undefined) return { success: true, returnData: encodeAddress(ZERO) };
      return { success: true, returnData: encodeAddress(fakePool(a, b, Number(fee))) };
    }
    if (decoded.functionName === "liquidity") {
      // Identify the pool by the call target, then return its configured liquidity.
      for (const [key, liq] of fixture.pools) {
        const [a, b, fee] = key.split("|");
        if (fakePool(a, b, Number(fee)).toLowerCase() === c.target.toLowerCase()) {
          return { success: true, returnData: encodeUint(liq) };
        }
      }
      return { success: true, returnData: encodeUint(0n) };
    }
    if (decoded.functionName === "quoteExactOutputSingle") {
      const p = (decoded.args as [Record<string, unknown>])[0];
      const amountIn = fixture.exactOut.get(
        hopKey(String(p.tokenIn), String(p.tokenOut), Number(p.fee)),
      );
      if (amountIn === undefined) return { success: false, returnData: "0x" };
      return { success: true, returnData: encodeQuote(amountIn) };
    }
    if (decoded.functionName === "quoteExactInputSingle") {
      const p = (decoded.args as [Record<string, unknown>])[0];
      const amountOut = fixture.exactIn.get(
        hopKey(String(p.tokenIn), String(p.tokenOut), Number(p.fee)),
      );
      if (amountOut === undefined) return { success: false, returnData: "0x" };
      return { success: true, returnData: encodeQuote(amountOut) };
    }
    return { success: false, returnData: "0x" };
  });
}

beforeEach(() => {
  fixture = emptyFixture();
  readContract.mockReset();
  call.mockReset();
  readContract.mockImplementation(async (c: { functionName?: string; args?: unknown[] }) => {
    if (fixture.rpcFails) throw new Error("RPC unavailable");
    if (c.functionName === "aggregate3") {
      return handleAggregate(c.args![0] as { target: string; callData: string }[]);
    }
    throw new Error(`unexpected readContract: ${c.functionName}`);
  });
  global.fetch = vi.fn(async () => {
    throw new Error("no network in test");
  }) as unknown as typeof fetch;

  // cbBTC + EURW are registered as seeds so they are always in the probe set,
  // exactly like the endpoints production passes to `quote`.
  registerToken({
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    address: CBTC,
    decimals: 8,
    fallbackUsd: 0,
    tint: "#F7931A",
    source: "seed",
    seed: true,
  });
  registerToken({
    symbol: "EURW",
    name: "Newrails Euro",
    address: EURW,
    decimals: 6,
    fallbackUsd: 0,
    tint: "#2775CA",
    source: "seed",
    seed: true,
  });
});

function provider() {
  return new UniswapV3Provider("mainnet");
}

/** $5 exact-output ("recipient receives 5 USDC") from cbBTC. */
function quoteFiveUsdc(p: InstanceType<typeof UniswapV3Provider>) {
  return p.quote({
    payToken: { symbol: "cbBTC", name: "cbBTC", address: CBTC, decimals: 8, fallbackUsd: 0, tint: "#F7931A", source: "seed", seed: true },
    receiveToken: { symbol: "USDC", name: "USDC", address: USDC, decimals: 6, fallbackUsd: 1, tint: "#2775CA", source: "seed", seed: true },
    mode: "recipient_receives",
    amount: "5",
    usd: true,
    network: "mainnet",
  });
}

describe("zero-liquidity pools are excluded from route discovery", () => {
  it("a pool that exists but has no active liquidity cannot bridge the route", async () => {
    // cbBTC -> EURW exists on chain but holds zero liquidity; EURW -> USDC is
    // healthy. The empty cbBTC pool must be dropped, leaving cbBTC unreachable.
    fixture.pools.set(poolKey(CBTC, EURW, 3000), 0n);
    fixture.pools.set(poolKey(EURW, USDC, 100), 150_136_712_082_108n);
    fixture.exactOut.set(hopKey(EURW, USDC, 100), 4_467_000n);

    const p = provider();
    // The zero-liquidity pool is dropped from the graph, so cbBTC (which only
    // touches that empty pool here) has no route at all.
    expect(await p.isRoutable(getToken("cbBTC")!)).toBe(false);

    const res = await quoteFiveUsdc(p);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("route_unavailable");
  });

  it("a pay token with no pools at all has no route", async () => {
    fixture.pools.set(poolKey(EURW, USDC, 100), 150_136_712_082_108n);
    fixture.exactOut.set(hopKey(EURW, USDC, 100), 4_467_000n);

    const res = await quoteFiveUsdc(provider());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("route_unavailable");
  });
});

describe("a genuinely liquid multi-hop exact-output route still quotes", () => {
  it("cbBTC -> EURW -> USDC quotes $5 when every hop has positive liquidity", async () => {
    // Both hops liquid. Quote outputs are fixed fixtures (the test asserts the
    // route shape, not the economics); the exact-input values are chosen so the
    // provider's near-spot price-impact probe is consistent (impact ~0).
    fixture.pools.set(poolKey(CBTC, EURW, 3000), 9_000_000_000_000_000n);
    fixture.pools.set(poolKey(EURW, USDC, 100), 150_136_712_082_108n);
    fixture.exactOut.set(hopKey(EURW, USDC, 100), 4_467_000n); // EURW needed for 5 USDC
    fixture.exactOut.set(hopKey(CBTC, EURW, 3000), 50_000n); // cbBTC needed for that EURW
    fixture.exactIn.set(hopKey(CBTC, EURW, 3000), 447n);
    fixture.exactIn.set(hopKey(EURW, USDC, 100), 500n);

    const res = await quoteFiveUsdc(provider());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.route.path).toEqual(["cbBTC", "EURW", "USDC"]);
    expect(res.route.path.length).toBeGreaterThan(2); // genuinely multi-hop
    expect(res.exactOutput).toBe(true);
    expect(res.receiveAmount).toBe("5"); // the requested recipient amount is preserved
    expect(Number(res.payAmount)).toBeGreaterThan(0);
  });
});

describe("an RPC failure is not misreported as a zero-liquidity outcome", () => {
  it("degrades to route_unavailable instead of throwing", async () => {
    // Discovery cannot read any pool. The provider must return its documented
    // honest failure, never crash. (The live test separately treats a thrown RPC
    // error as a test failure rather than skipping — see liveRouting.test.ts.)
    fixture.rpcFails = true;

    const res = await quoteFiveUsdc(provider());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("route_unavailable");
  });
});
