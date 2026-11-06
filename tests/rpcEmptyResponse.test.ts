import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, type Address } from "viem";

/**
 * Regression: an RPC that answers HTTP 200 but returns *no usable data*.
 *
 * The production symptom was "zero liquidity" that never recovered. The keyed
 * Alchemy endpoint intermittently answered with an empty body (a 429-style
 * response rendered as an empty/broken result). viem surfaces that as a
 * successful `aggregate3` whose every sub-call is `{ success: false }` — NOT as
 * a thrown transport error.
 *
 * `isRpcUnreachable` only inspected *thrown* values, so `rpcFailed` stayed
 * false, the empty graph was treated as a real market fact, the quote came back
 * `route_unavailable` (a definitive code), and the composer cleared the
 * last-known-good quote and stopped retrying. A transient infrastructure fault
 * became a permanent, unrecoverable "no route".
 *
 * These tests pin the distinction: an empty successful read is infrastructure
 * (transient `provider_error`), while a genuinely empty pool is still a real
 * `route_unavailable`.
 */

const readContract = vi.fn();
const call = vi.fn();

vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({ readContract, call }),
}));

const { UniswapV3Provider } = await import("@/lib/providers/uniswapV3");
const { registerToken } = await import("@/lib/config/tokens");

const ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function liquidity() view returns (uint128)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amountOut, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";
const USDT = "0xe7cd86e13ac4309349f30b3435a9d337750fc82d" as Address;
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603" as Address;

function encodeAddress(a: string): string {
  return encodeAbiParameters(parseAbiParameters("address"), [a as Address]);
}
function encodeUint(n: bigint): string {
  return encodeAbiParameters(parseAbiParameters("uint256"), [n]);
}
function encodeQuote(amount: bigint): string {
  return encodeAbiParameters(parseAbiParameters("uint256,uint160,uint32,uint256"), [amount, 0n, 0, 0n]);
}

const USDT_TOKEN = {
  symbol: "USDT",
  name: "Tether USD",
  address: USDT,
  decimals: 6,
  fallbackUsd: 1,
  tint: "#26A17B",
  source: "seed" as const,
  seed: true,
};
const USDC_TOKEN = {
  symbol: "USDC",
  name: "USD Coin",
  address: USDC,
  decimals: 6,
  fallbackUsd: 1,
  tint: "#2775CA",
  source: "seed" as const,
  seed: true,
};

/**
 * How the fake node answers `aggregate3`.
 *  - "ok": real pools + liquidity (a healthy node)
 *  - "empty": HTTP 200 but every sub-call fails (the production 429/empty body)
 */
let mode: "ok" | "empty" = "ok";

function poolFor(a: string, b: string, fee: number): Address {
  const seed = [a.toLowerCase(), b.toLowerCase()].sort().join(":") + ":" + fee;
  let h = 0n;
  for (const ch of seed) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 160n);
  return ("0x" + h.toString(16).padStart(40, "0")) as Address;
}

function handleAggregate(slice: { target: string; callData: string }[]) {
  // The empty-body node: the aggregate call succeeds, every entry fails.
  if (mode === "empty") return slice.map(() => ({ success: false, returnData: "0x" }));

  return slice.map((c) => {
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: ABI, data: c.callData as `0x${string}` }) as unknown as {
        functionName: string;
        args: readonly unknown[];
      };
    } catch {
      return { success: false, returnData: "0x" };
    }
    if (decoded.functionName === "getPool") {
      const [a, b, fee] = decoded.args as [string, string, number];
      // Only the USDT/USDC 100-fee pool exists, with real liquidity.
      if (Number(fee) !== 100) return { success: true, returnData: encodeAddress(ZERO) };
      const lower = [a.toLowerCase(), b.toLowerCase()].sort().join("|");
      if (lower !== [USDT.toLowerCase(), USDC.toLowerCase()].sort().join("|")) {
        return { success: true, returnData: encodeAddress(ZERO) };
      }
      return { success: true, returnData: encodeAddress(poolFor(a, b, Number(fee))) };
    }
    if (decoded.functionName === "liquidity") {
      return { success: true, returnData: encodeUint(10n ** 18n) };
    }
    if (decoded.functionName === "quoteExactOutputSingle") {
      return { success: true, returnData: encodeQuote(100133n) };
    }
    if (decoded.functionName === "quoteExactInputSingle") {
      return { success: true, returnData: encodeQuote(99867n) };
    }
    return { success: false, returnData: "0x" };
  });
}

beforeEach(() => {
  mode = "ok";
  readContract.mockReset();
  call.mockReset();
  readContract.mockImplementation(async (c: { functionName?: string; args?: unknown[] }) => {
    if (c.functionName === "aggregate3") {
      return handleAggregate(c.args![0] as { target: string; callData: string }[]);
    }
    throw new Error(`unexpected readContract: ${c.functionName}`);
  });
  call.mockImplementation(async () => ({ data: "0x" }));
  global.fetch = vi.fn(async () => {
    throw new Error("no network in test");
  }) as unknown as typeof fetch;

  registerToken(USDT_TOKEN);
  registerToken(USDC_TOKEN);
});

const REQ = { network: "mainnet" as const, mode: "recipient_receives" as const, amount: "0.1" };

describe("an RPC that returns an empty result set", () => {
  it("reports a transient provider_error, not a definitive route_unavailable", async () => {
    const p = new UniswapV3Provider("mainnet");
    // Warm the graph while the node is healthy.
    const healthy = await p.quote({ ...REQ, payToken: USDT_TOKEN, receiveToken: USDC_TOKEN });
    expect(healthy.ok).toBe(true);

    // The node now answers 200 with no usable data (the production 429/empty body).
    mode = "empty";
    const failed = await p.quote({ ...REQ, payToken: USDT_TOKEN, receiveToken: USDC_TOKEN });
    expect(failed.ok).toBe(false);
    // The critical assertion: an unreachable node must never be reported as a
    // market fact, or the client stops retrying and the payment dead-ends.
    expect(failed.ok === false && failed.code).toBe("provider_error");
  });

  it("still reports route_unavailable when the node answers but there is genuinely no pool", async () => {
    const p = new UniswapV3Provider("mainnet");
    // A pair with no pool at all: getPool returns the zero address for every fee.
    const empty = { ...USDC_TOKEN, symbol: "ZZZ", address: "0x00000000000000000000000000000000000000zz".replace("zz", "99") as Address };
    registerToken(empty);
    const res = await p.quote({ ...REQ, payToken: USDT_TOKEN, receiveToken: empty });
    expect(res.ok).toBe(false);
    // A real answer from a reachable node stays definitive.
    expect(res.ok === false && res.code).toBe("route_unavailable");
  });

  it("reports a transient provider_error on a COLD quote too (no warmed graph)", async () => {
    // No healthy quote first: the outage hits the very first read, which is the
    // graph build. That path goes through `multicall`, so this is what proves
    // the graph-build half of the fix is load-bearing.
    mode = "empty";
    const p = new UniswapV3Provider("mainnet");
    const res = await p.quote({ ...REQ, payToken: USDT_TOKEN, receiveToken: USDC_TOKEN });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.code).toBe("provider_error");
  });
});
