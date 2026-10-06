import {
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  type PublicClient,
} from "viem";
import { getPublicClient } from "@/lib/server/rpc";
import { NATIVE_ADDRESS } from "@/lib/config/chains";
import { TOKENS, getToken, type TokenConfig } from "@/lib/config/tokens";
import { formatUnits, parseUnits } from "@/lib/domain/math";
import type { Route, RouteHop } from "@/lib/domain/intent";
import { FEE_TIERS, HUB_SYMBOLS, UNISWAP, WMON_ADDRESS } from "./constants";
import type {
  RouteQuoteRequest,
  RouteQuoteResult,
  RoutingProvider,
  UsdPrice,
} from "./types";

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)"]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amountOut, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const STABLES = new Set(["USDC", "USDT", "AUSD", "USD1", "mUSD"]);
const ZERO = "0x0000000000000000000000000000000000000000";

type PoolInfo = { pool: `0x${string}`; fee: number; liquidity: bigint };

function eq(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** The ERC-20 address used by pools for a token (native MON is pooled as WMON). */
function poolAddress(token: TokenConfig): `0x${string}` {
  return token.native ? WMON_ADDRESS : token.address;
}

export class UniswapV3Provider implements RoutingProvider {
  readonly name = "uniswap-v3-monad";
  readonly mode = "live" as const;

  private poolCache = new Map<string, PoolInfo | null>();
  private priceCache = new Map<string, { value: UsdPrice; at: number }>();
  private availCache = new Map<string, { value: string[]; at: number }>();

  constructor(private network: "mainnet" | "testnet" = "mainnet") {}

  private client(): PublicClient {
    return getPublicClient(this.network);
  }

  supports(token: TokenConfig): boolean {
    return TOKENS.some((t) => eq(t.address, token.address));
  }

  private async read<T>(
    to: `0x${string}`,
    abi: any,
    functionName: string,
    args: unknown[],
  ): Promise<T | null> {
    try {
      const data = encodeFunctionData({ abi, functionName, args } as any);
      const result = await this.client().call({ to, data });
      if (!result.data) return null;
      return decodeFunctionResult({
        abi,
        functionName,
        data: result.data,
      } as any) as T;
    } catch {
      return null;
    }
  }

  /** Best (deepest) pool for a pair, or null when no liquid pool exists. */
  private async getPool(a: TokenConfig, b: TokenConfig): Promise<PoolInfo | null> {
    const key = [poolAddress(a), poolAddress(b)]
      .map((x) => x.toLowerCase())
      .sort()
      .join(":");
    if (this.poolCache.has(key)) return this.poolCache.get(key)!;

    let best: PoolInfo | null = null;
    for (const fee of FEE_TIERS) {
      const pool = await this.read<`0x${string}`>(
        UNISWAP.v3Factory as `0x${string}`,
        FACTORY_ABI,
        "getPool",
        [poolAddress(a), poolAddress(b), fee],
      );
      if (!pool || pool === ZERO) continue;
      const liq = await this.read<bigint>(pool, POOL_ABI, "liquidity", []);
      const liquidity = (liq as bigint) ?? 0n;
      if (liquidity > 0n && (!best || liquidity > best.liquidity)) {
        best = { pool, fee, liquidity };
      }
    }
    this.poolCache.set(key, best);
    return best;
  }

  private async quoteExactIn(
    a: TokenConfig,
    b: TokenConfig,
    fee: number,
    amountIn: bigint,
  ): Promise<{ amountOut: bigint; gas: bigint } | null> {
    const res = await this.read<[bigint, bigint, number, bigint]>(
      UNISWAP.quoterV2 as `0x${string}`,
      QUOTER_ABI,
      "quoteExactInputSingle",
      [
        {
          tokenIn: poolAddress(a),
          tokenOut: poolAddress(b),
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    );
    if (!res) return null;
    return { amountOut: res[0] as bigint, gas: (res[3] as bigint) ?? 0n };
  }

  private async quoteExactOut(
    a: TokenConfig,
    b: TokenConfig,
    fee: number,
    amountOut: bigint,
  ): Promise<{ amountIn: bigint; gas: bigint } | null> {
    const res = await this.read<[bigint, bigint, number, bigint]>(
      UNISWAP.quoterV2 as `0x${string}`,
      QUOTER_ABI,
      "quoteExactOutputSingle",
      [
        {
          tokenIn: poolAddress(a),
          tokenOut: poolAddress(b),
          amountOut,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    );
    if (!res) return null;
    return { amountIn: res[0] as bigint, gas: (res[3] as bigint) ?? 0n };
  }

  /** Build candidate hop sequences (direct + 2-hop via hubs). */
  private candidatePaths(pay: TokenConfig, receive: TokenConfig): TokenConfig[][] {
    const paths: TokenConfig[][] = [];
    if (!eq(pay.address, receive.address)) paths.push([pay, receive]);

    const hubs = HUB_SYMBOLS.map((s) => getToken(s)).filter(
      (t): t is TokenConfig => Boolean(t),
    );
    for (const hub of hubs) {
      if (eq(hub.address, pay.address) || eq(hub.address, receive.address)) continue;
      paths.push([pay, hub, receive]);
    }
    return paths;
  }

  private async resolveHops(path: TokenConfig[]): Promise<RouteHop[] | null> {
    const hops: RouteHop[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const pool = await this.getPool(a, b);
      if (!pool) return null;
      hops.push({
        fromSymbol: a.symbol,
        toSymbol: b.symbol,
        fee: pool.fee,
        pool: pool.pool,
      });
    }
    return hops;
  }

  async quote(req: RouteQuoteRequest): Promise<RouteQuoteResult> {
    const { payToken, receiveToken, mode } = req;

    // The composer expresses intent in dollars ("$5.00 SOL"); resolve that to
    // token units for the token whose amount the user is fixing.
    let amount = req.amount;
    if (req.usd === true) {
      const priceToken = mode === "i_spend" ? payToken : receiveToken;
      const price = await this.priceUsd(priceToken);
      const units = Number(req.amount) / price.usd;
      amount = formatUnits(
        parseUnits(units.toFixed(priceToken.decimals), priceToken.decimals),
        priceToken.decimals,
      );
    }

    // Same asset: a direct transfer, no route needed.
    if (eq(payToken.address, receiveToken.address)) {
      return {
        ok: true,
        route: {
          kind: "direct",
          hops: [],
          path: [payToken.symbol, receiveToken.symbol],
        },
        payAmount: amount,
        receiveAmount: amount,
        rate: 1,
        gasEstimate: 120_000n,
        exactOutput: false,
      };
    }

    const paths = this.candidatePaths(payToken, receiveToken);
    let best:
      | {
          hops: RouteHop[];
          path: TokenConfig[];
          payAmount: bigint;
          receiveAmount: bigint;
          gas: bigint;
        }
      | null = null;

    for (const path of paths) {
      const hops = await this.resolveHops(path);
      if (!hops) continue;

      if (mode === "recipient_receives") {
        const target = parseUnits(amount, receiveToken.decimals);
        if (target <= 0n) continue;
        let needed = target;
        let gas = 0n;
        let failed = false;
        for (let i = hops.length - 1; i >= 0; i--) {
          const r = await this.quoteExactOut(path[i], path[i + 1], hops[i].fee, needed);
          if (!r) {
            failed = true;
            break;
          }
          needed = r.amountIn;
          gas += r.gas;
        }
        if (failed) continue;
        if (!best || needed < best.payAmount) {
          best = { hops, path, payAmount: needed, receiveAmount: target, gas };
        }
      } else {
        const spend = parseUnits(amount, payToken.decimals);
        if (spend <= 0n) continue;
        let out = spend;
        let gas = 0n;
        let failed = false;
        for (let i = 0; i < hops.length; i++) {
          const r = await this.quoteExactIn(path[i], path[i + 1], hops[i].fee, out);
          if (!r) {
            failed = true;
            break;
          }
          out = r.amountOut;
          gas += r.gas;
        }
        if (failed) continue;
        if (!best || out > best.receiveAmount) {
          best = { hops, path, payAmount: spend, receiveAmount: out, gas };
        }
      }
    }

    if (!best) {
      return {
        ok: false,
        code: "route_unavailable",
        message: "There's currently no supported route for this payment.",
        alternatives: await this.availableSymbols(),
      };
    }

    const payAmount = formatUnits(best.payAmount, payToken.decimals);
    const receiveAmount = formatUnits(best.receiveAmount, receiveToken.decimals);
    const rate =
      Number(best.payAmount) > 0
        ? Number(best.receiveAmount) / Number(best.payAmount)
        : 0;

    const route: Route = {
      kind: "swap",
      hops: best.hops,
      path: best.path.map((t) => t.symbol),
    };

    return {
      ok: true,
      route,
      payAmount,
      receiveAmount,
      rate,
      gasEstimate: best.gas + 60_000n,
      exactOutput: mode === "recipient_receives",
    };
  }

  async priceUsd(token: TokenConfig): Promise<UsdPrice> {
    if (STABLES.has(token.symbol)) {
      return { usd: 1, source: "stable" };
    }
    const key = token.symbol;
    const cached = this.priceCache.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;

    const probe: Record<string, string> = { MON: "1", WETH: "0.01", SOL: "0.1" };
    const amount = probe[token.symbol] ?? "1";
    const probeUnits = parseUnits(amount, token.decimals);

    const stables = ["USDC", "USDT"]
      .map((s) => getToken(s))
      .filter((t): t is TokenConfig => Boolean(t));

    let bestUsd: number | null = null;
    for (const stable of stables) {
      if (eq(stable.address, token.address)) continue;
      const hops = await this.resolveHops([token, stable]);
      if (!hops) continue;
      const r = await this.quoteExactIn(token, stable, hops[0].fee, probeUnits);
      if (!r) continue;
      const usd = Number(formatUnits(r.amountOut, stable.decimals)) / Number(amount);
      if (usd > 0 && (bestUsd === null || Math.abs(usd - 1) < Math.abs(bestUsd - 1))) {
        bestUsd = usd;
      }
    }

    const value: UsdPrice =
      bestUsd !== null
        ? { usd: bestUsd, source: "onchain" }
        : { usd: token.fallbackUsd, source: "fallback" };
    this.priceCache.set(key, { value, at: Date.now() });
    return value;
  }

  async availableSymbols(): Promise<string[]> {
    const cached = this.availCache.get(this.network);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;

    const liquid = new Set<string>();
    for (const token of TOKENS) {
      if (STABLES.has(token.symbol)) {
        liquid.add(token.symbol);
        continue;
      }
      for (const stable of ["USDC", "USDT"]) {
        const s = getToken(stable);
        if (!s || eq(s.address, token.address)) continue;
        const pool = await this.getPool(token, s);
        if (pool) {
          liquid.add(token.symbol);
          break;
        }
      }
    }
    const value = Array.from(liquid);
    this.availCache.set(this.network, { value, at: Date.now() });
    return value;
  }
}

export function tokenAddressIsNative(address: string) {
  return eq(address, NATIVE_ADDRESS);
}
