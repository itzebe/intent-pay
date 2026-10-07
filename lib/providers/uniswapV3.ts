import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address, type PublicClient } from "viem";
import { getPublicClient } from "@/lib/server/rpc";
import {
  allTokens,
  catalogVersion,
  configFromCurated,
  curatedCatalog,
  getToken,
  isUsdAnchor,
  USD_ANCHOR_SYMBOLS,
  type TokenConfig,
} from "@/lib/config/tokens";
import { formatUnits, parseUnits } from "@/lib/domain/math";
import type { Route, RouteHop } from "@/lib/domain/intent";
import { FEE_TIERS, UNISWAP, WMON_ADDRESS } from "./constants";
import { getMarketPriceUsd } from "@/lib/server/pricing/market";
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

const ZERO = "0x0000000000000000000000000000000000000000";

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const AGGREGATE3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const MAX_HOPS = 3;
/** How many candidate pool keys to explore from each endpoint. */
const CANDIDATE_LIMIT = 60;
const GRAPH_TTL_MS = 5 * 60 * 1000;
const PRICE_TTL_MS = 30 * 1000;
/** Bounds on how many tokens we will quote against, to keep latency sane. */
const MAX_BASIS_TOKENS = 24;
const MAX_DISCOVERY_TOKENS = 24;

type PoolInfo = { pool: Address; fee: number; liquidity: bigint; to: Address };

function eq(a: string, b: string) {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/** The ERC-20 address used by pools for a token (native MON is pooled as WMON). */
function poolAddress(token: TokenConfig): Address {
  return (token.native ? WMON_ADDRESS : token.address) as Address;
}

function poolKey(token: TokenConfig): string {
  return poolAddress(token).toLowerCase();
}

type HopQuote = { to: TokenConfig; fee: number; pool: Address; out: bigint };

/**
 * Live Uniswap V3 routing on Monad.
 *
 * There is no hardcoded route table. The provider discovers pools by asking the
 * V3 factory about pairs around the tokens involved in the payment (endpoints,
 * seed tokens, and the highest-liquidity tokens from the official Monad list),
 * builds a graph from the pools that actually exist with liquidity, and finds
 * the cheapest path. A token launched after deployment becomes routable as soon
 * as its pool exists — no code change required.
 *
 * Discovery is intentionally bounded: querying all ~120 listed tokens pairwise
 * is ~28k calls and far too slow for an interactive quote.
 */
export class UniswapV3Provider implements RoutingProvider {
  readonly name = "uniswap-v3-monad";
  readonly mode = "live" as const;

  private graph: {
    adjacency: Map<string, PoolInfo[]>;
    basisKeys: Set<string>;
    at: number;
    catalogVersion: string;
  } | null = null;
  private tokenByKey = new Map<string, TokenConfig>();
  private priceCache = new Map<string, { value: UsdPrice; at: number }>();
  private availCache = new Map<string, { value: string[]; at: number }>();
  /** Token keys with the deepest total liquidity, used to pick basis tokens. */
  private liquidityScore = new Map<string, bigint>();

  constructor(private network: "mainnet" | "testnet" = "mainnet") {}

  private client(): PublicClient {
    return getPublicClient(this.network);
  }

  supports(token: TokenConfig): boolean {
    return Boolean(token?.address);
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  private seedTokens(): TokenConfig[] {
    const byKey = new Map<string, TokenConfig>();
    const add = (t: TokenConfig) => {
      const k = poolKey(t);
      if (!byKey.has(k)) byKey.set(k, t);
    };
    for (const t of allTokens()) add(t);
    const native = getToken("MON");
    if (native) add(native);
    return [...byKey.values()];
  }

  /**
   * Keep the key->token index in sync with the runtime registry.
   *
   * This must run for *every* basis token, not just the seeds: a token
   * discovered after the graph was first built (e.g. newly listed upstream, or
   * pasted by the user) has to be resolvable by key, otherwise the path search
   * cannot traverse to it even though its pool is in the graph.
   */
  private indexTokens(tokens: TokenConfig[]): void {
    for (const t of tokens) this.tokenByKey.set(poolKey(t), t);
  }

  /**
   * The token set we will actually probe against. Endpoints are always
   * included; the rest are the most liquid tokens we know of, plus the highest
   * liquidity tokens seen on chain so far.
   */
  private basisTokens(endpoints: TokenConfig[]): TokenConfig[] {
    const seen = new Set<string>();
    const out: TokenConfig[] = [];
    const add = (t: TokenConfig) => {
      const k = poolKey(t);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    };
    for (const t of endpoints) add(t);

    const seeds = this.seedTokens();
    // Known-liquid seed tokens (stablecoins, WETH, WMON) first.
    for (const t of seeds) {
      if (t.seed && !t.native) add(t);
      if (out.length >= MAX_BASIS_TOKENS) break;
    }
    // Then anything we have already measured liquidity for.
    const scored = [...this.liquidityScore.entries()].sort((a, b) =>
      b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
    );
    for (const [key] of scored) {
      const t = this.tokenByKey.get(key);
      if (t) add(t);
      if (out.length >= MAX_BASIS_TOKENS) break;
    }
    // Finally, curated entries (deterministic, includes well-known tokens).
    for (const c of curatedCatalog().map((c) => configFromCurated(c))) {
      add(c);
      if (out.length >= MAX_BASIS_TOKENS) break;
    }
    const basis = out.slice(0, MAX_BASIS_TOKENS);
    // Every basis token must be resolvable by key for the path search.
    this.indexTokens(basis);
    return basis;
  }

  // -------------------------------------------------------------------------
  // Pool graph discovery (bounded)
  // -------------------------------------------------------------------------

  private async ensureGraph(endpoints: TokenConfig[]): Promise<Map<string, PoolInfo[]>> {
    const version = catalogVersion();
    // A catalog change (e.g. a token list refresh) must not be served from a
    // graph that was built before the new tokens were known.
    const sameCatalog = this.graph?.catalogVersion === version;
    const fresh = this.graph && sameCatalog && Date.now() - this.graph.at < GRAPH_TTL_MS;
    if (fresh && this.coversEndpoints(endpoints)) return this.graph!.adjacency;

    const basis = this.basisTokens(endpoints);
    const basisKeys = new Set(basis.map(poolKey));
    const pairs: { a: Address; b: Address }[] = [];
    for (let i = 0; i < basis.length; i++) {
      for (let j = i + 1; j < basis.length; j++) {
        pairs.push({ a: poolAddress(basis[i]), b: poolAddress(basis[j]) });
      }
    }

    const poolCalls = pairs.flatMap((p) =>
      FEE_TIERS.map((fee) => ({
        address: UNISWAP.v3Factory as Address,
        abi: FACTORY_ABI as any,
        functionName: "getPool" as const,
        args: [p.a, p.b, fee] as const,
      })),
    );

    const pools = await this.multicall<Address>(poolCalls);

    const existing: { a: Address; b: Address; fee: number; pool: Address }[] = [];
    pools.forEach((pool, idx) => {
      if (!pool || eq(pool, ZERO)) return;
      const pair = pairs[Math.floor(idx / FEE_TIERS.length)];
      existing.push({ a: pair.a, b: pair.b, fee: FEE_TIERS[idx % FEE_TIERS.length], pool });
    });

    const liquidity = await this.multicall<bigint>(
      existing.map((e) => ({
        address: e.pool,
        abi: POOL_ABI as any,
        functionName: "liquidity" as const,
        args: [] as const,
      })),
    );

    const adjacency = new Map<string, PoolInfo[]>();
    const link = (from: Address, to: Address, info: Omit<PoolInfo, "to">) => {
      const k = from.toLowerCase();
      const list = adjacency.get(k) ?? [];
      list.push({ ...info, to });
      adjacency.set(k, list);
    };

    existing.forEach((e, i) => {
      const liq = (liquidity[i] as bigint) ?? 0n;
      if (liq <= 0n) return;
      const info = { pool: e.pool, fee: e.fee, liquidity: liq };
      link(e.a, e.b, info);
      link(e.b, e.a, info);
      this.bumpScore(e.a.toLowerCase(), liq);
      this.bumpScore(e.b.toLowerCase(), liq);
    });

    // Merge into the existing graph so a later, narrower quote keeps the pools
    // discovered for a previous, wider one. Start from scratch when the catalog
    // itself changed, so stale tokens can't linger.
    if (this.graph && sameCatalog) {
      for (const [k, edges] of adjacency) {
        const prev = this.graph.adjacency.get(k) ?? [];
        const merged = [...prev];
        for (const e of edges) {
          if (!merged.some((m) => eq(m.pool, e.pool) && eq(m.to, e.to) && m.fee === e.fee)) {
            merged.push(e);
          }
        }
        this.graph.adjacency.set(k, merged);
      }
      for (const k of basisKeys) this.graph.basisKeys.add(k);
      this.graph.at = Date.now();
      return this.graph.adjacency;
    }

    this.graph = { adjacency, basisKeys, at: Date.now(), catalogVersion: version };
    return adjacency;
  }

  private bumpScore(key: string, liq: bigint) {
    this.liquidityScore.set(key, (this.liquidityScore.get(key) ?? 0n) + liq);
  }

  private coversEndpoints(endpoints: TokenConfig[]): boolean {
    if (!this.graph) return false;
    return endpoints.every((t) => this.graph!.basisKeys.has(poolKey(t)));
  }

  private async multicall<T>(
    calls: { address: Address; abi: any; functionName: string; args: readonly unknown[] }[],
  ): Promise<(T | null)[]> {
    if (calls.length === 0) return [];
    // Batch through Multicall3.aggregate3 in a single eth_call. This is far
    // more reliable than the JSON-RPC `eth_call` batch that viem's multicall
    // emits (Monad's public RPC intermittently drops entries in a batch), and
    // it returns per-call success flags so a single bad call can't poison the
    // whole read.
    try {
      const results = await this.aggregate3<T>(calls);
      const failed = results.filter((r) => r === null).length;
      if (failed > 0 && failed === results.length) {
        // Every call failed — fall back so a broken aggregate can't look like
        // "no pools exist".
        throw new Error("aggregate3 returned no successful calls");
      }
      return results;
    } catch (err) {
      console.warn(
        `[routing] aggregate3 failed for ${calls.length} calls, falling back to sequential reads:`,
        (err as Error)?.message,
      );
      const out: (T | null)[] = [];
      for (const c of calls) {
        try {
          out.push((await this.client().readContract(c as any)) as T);
        } catch {
          out.push(null);
        }
      }
      return out;
    }
  }

  /** One eth_call to Multicall3.aggregate3, decoding each raw return. */
  private async aggregate3<T>(
    calls: { address: Address; abi: any; functionName: string; args: readonly unknown[] }[],
  ): Promise<(T | null)[]> {
    const CHUNK = 800;
    const out: (T | null)[] = [];
    for (let i = 0; i < calls.length; i += CHUNK) {
      const slice = calls.slice(i, i + CHUNK).map((c) => ({
        target: c.address,
        allowFailure: true,
        callData: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }),
      }));
      const res = (await this.client().readContract({
        address: MULTICALL3_ADDRESS,
        abi: AGGREGATE3_ABI as any,
        functionName: "aggregate3",
        args: [slice],
      })) as readonly { success: boolean; returnData: string }[];

      res.forEach((r, idx) => {
        if (!r?.success || !r.returnData || r.returnData === "0x") {
          out.push(null);
          return;
        }
        const call = calls[i + idx];
        try {
          out.push(
            decodeFunctionResult({
              abi: call.abi,
              functionName: call.functionName,
              data: r.returnData as `0x${string}`,
            }) as T,
          );
        } catch {
          out.push(null);
        }
      });
    }
    return out;
  }

  /** Quote several hops in one round-trip.
   *
   * QuoterV2 returns its result by *reverting* with the ABI-encoded value.
   * viem's `multicall` discards revert data, so we call Multicall3's
   * `aggregate3` ourselves and decode each raw return.
   */
  private async quoteMany(
    requests: { a: TokenConfig; b: TokenConfig; fee: number; amount: bigint; exactOut: boolean }[],
  ): Promise<(bigint | null)[]> {
    if (requests.length === 0) return [];

    const calls = requests.map((r) => {
      const functionName = r.exactOut ? "quoteExactOutputSingle" : "quoteExactInputSingle";
      const args = [
        {
          tokenIn: poolAddress(r.a),
          tokenOut: poolAddress(r.b),
          fee: r.fee,
          sqrtPriceLimitX96: 0n,
          ...(r.exactOut ? { amountOut: r.amount } : { amountIn: r.amount }),
        },
      ];
      return {
        target: UNISWAP.quoterV2 as Address,
        allowFailure: true,
        callData: encodeFunctionData({ abi: QUOTER_ABI as any, functionName, args: args as any }),
      };
    });

    const decodeReturn = (raw: string): bigint | null => {
      try {
        const inner = decodeFunctionResult({
          abi: QUOTER_ABI as any,
          functionName: "quoteExactInputSingle",
          data: raw as `0x${string}`,
        }) as readonly [bigint, bigint, number, bigint];
        return inner[0];
      } catch {
        return null;
      }
    };

    const out: (bigint | null)[] = [];
    const CHUNK = 300;
    for (let i = 0; i < calls.length; i += CHUNK) {
      const slice = calls.slice(i, i + CHUNK);
      try {
        const res = (await this.client().readContract({
          address: MULTICALL3_ADDRESS,
          abi: AGGREGATE3_ABI as any,
          functionName: "aggregate3",
          args: [slice],
        })) as readonly { success: boolean; returnData: string }[];
        for (const r of res) {
          out.push(
            r?.success && r.returnData && r.returnData !== "0x"
              ? decodeReturn(r.returnData)
              : null,
          );
        }
      } catch {
        // Fallback: one call at a time. A revert here carries the encoded
        // quote as revert data.
        for (const c of slice) {
          try {
            const raw = (await this.client().call({ to: c.target, data: c.callData })) as {
              data?: string;
            };
            out.push(raw?.data ? decodeReturn(raw.data) : null);
          } catch (err: any) {
            const revertData: string | undefined = err?.data ?? err?.cause?.data;
            out.push(revertData ? decodeReturn(revertData) : null);
          }
        }
      }
    }
    return out;
  }

  private async quoteSingle(
    a: TokenConfig,
    b: TokenConfig,
    fee: number,
    amount: bigint,
    exactOut: boolean,
  ): Promise<bigint | null> {
    return (await this.quoteMany([{ a, b, fee, amount, exactOut }]))[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Path search (bounded beam over real quotes)
  // -------------------------------------------------------------------------

  /**
   * Expand from `from` toward `to` using real quoter output as the cost.
   *
   * Only a bounded set of neighbours is expanded per node: the pools with the
   * deepest liquidity, preferring those that connect to the other endpoint or
   * to the tokens with the most connections. Without this the graph is dense
   * enough that a naive search fans out into hundreds of quoter calls.
   */
  private async findBestPath(
    from: TokenConfig,
    to: TokenConfig,
    amount: bigint,
    exactOut: boolean,
  ): Promise<{ path: TokenConfig[]; fees: number[] } | null> {
    const adjacency = await this.ensureGraph([from, to]);
    const goalKey = poolKey(to);

    const neighbourEdges = (key: string): PoolInfo[] => {
      const edges = adjacency.get(key) ?? [];
      // Prefer edges that reach the goal, then the deepest pools. We keep every
      // fee tier: a token can have a pool at fee=100 that reverts while its
      // fee=3000 pool is the one with real liquidity.
      return [...edges]
        .sort((a, b) => {
          const ag = a.to.toLowerCase() === goalKey;
          const bg = b.to.toLowerCase() === goalKey;
          if (ag !== bg) return ag ? -1 : 1;
          return b.liquidity > a.liquidity ? 1 : b.liquidity < a.liquidity ? -1 : 0;
        })
        .slice(0, CANDIDATE_LIMIT);
    };

    let frontier: { key: string; path: TokenConfig[]; fees: number[]; cost: bigint }[] = [
      { key: poolKey(from), path: [from], fees: [], cost: 0n },
    ];

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      // Gather every expansion candidate, then quote them all at once.
      const requests: { a: TokenConfig; b: TokenConfig; fee: number; amount: bigint; exactOut: boolean }[] = [];
      const meta: { node: (typeof frontier)[number]; nextKey: string; fee: number }[] = [];

      for (const node of frontier) {
        const used = new Set(node.path.map(poolKey));
        const last = node.path[node.path.length - 1];
        for (const edge of neighbourEdges(node.key)) {
          const nextKey = edge.to.toLowerCase();
          if (used.has(nextKey)) continue;
          const nextToken = this.tokenByKey.get(nextKey);
          if (!nextToken) continue;
          requests.push({ a: last, b: nextToken, fee: edge.fee, amount, exactOut });
          meta.push({ node, nextKey, fee: edge.fee });
        }
      }

      if (requests.length === 0) break;
      const outs = await this.quoteMany(requests);

      const expansions: (typeof frontier)[number][] = [];
      const goals: (typeof frontier)[number][] = [];
      outs.forEach((out, i) => {
        if (out === null) return;
        const { node, nextKey, fee } = meta[i];
        const nextToken = this.tokenByKey.get(nextKey)!;
        const cost = node.cost + out;
        const candidate = {
          key: nextKey,
          path: [...node.path, nextToken],
          fees: [...node.fees, fee],
          cost,
        };
        if (nextKey === goalKey) goals.push(candidate);
        else expansions.push(candidate);
      });

      // A direct hit at this hop count is optimal — stop early.
      if (goals.length) {
        goals.sort((a, b) => (a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0));
        return { path: goals[0].path, fees: goals[0].fees };
      }
      if (expansions.length === 0) break;

      const ranked = expansions.sort((a, b) =>
        a.cost < b.cost ? -1 : a.cost > b.cost ? 1 : 0,
      );
      const perKey = new Map<string, (typeof frontier)[number]>();
      for (const e of ranked) if (!perKey.has(e.key)) perKey.set(e.key, e);
      frontier = [...perKey.values()].slice(0, 10);
    }

    return null;
  }

  private async resolveHops(path: TokenConfig[], fees: number[]): Promise<RouteHop[] | null> {
    const adjacency = this.graph?.adjacency;
    if (!adjacency) return null;
    const hops: RouteHop[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const aKey = poolKey(path[i]);
      const bKey = poolKey(path[i + 1]);
      const edge = (adjacency.get(aKey) ?? []).find(
        (p) => p.fee === fees[i] && p.to.toLowerCase() === bKey,
      );
      if (!edge) return null;
      hops.push({
        fromSymbol: path[i].symbol,
        toSymbol: path[i + 1].symbol,
        fee: edge.fee,
        pool: edge.pool,
      });
    }
    return hops;
  }

  private async quotePath(
    path: TokenConfig[],
    fees: number[],
    amount: bigint,
    exactOut: boolean,
  ): Promise<bigint | null> {
    if (exactOut) {
      let needed = amount;
      for (let i = path.length - 2; i >= 0; i--) {
        const r = await this.quoteSingle(path[i], path[i + 1], fees[i], needed, true);
        if (r === null) return null;
        needed = r;
      }
      return needed;
    }
    let out = amount;
    for (let i = 0; i < path.length - 1; i++) {
      const r = await this.quoteSingle(path[i], path[i + 1], fees[i], out, false);
      if (r === null) return null;
      out = r;
    }
    return out;
  }

  async quote(req: RouteQuoteRequest): Promise<RouteQuoteResult> {
    const { payToken, receiveToken, mode } = req;

    let amount = req.amount;
    if (req.usd === true) {
      const priceToken = mode === "i_spend" ? payToken : receiveToken;
      const price = await this.priceUsd(priceToken);
      if (!(price.usd > 0)) {
        return {
          ok: false,
          code: "route_unavailable",
          message: `We can't determine a price for ${priceToken.symbol}, so this payment can't be quoted.`,
          alternatives: await this.reachableSymbols(payToken, [receiveToken]),
        };
      }
      const units = Number(req.amount) / price.usd;
      amount = formatUnits(
        parseUnits(units.toFixed(priceToken.decimals), priceToken.decimals),
        priceToken.decimals,
      );
    }

    if (eq(payToken.address, receiveToken.address)) {
      return {
        ok: true,
        route: { kind: "direct", hops: [], path: [payToken.symbol, receiveToken.symbol] },
        payAmount: amount,
        receiveAmount: amount,
        rate: 1,
        gasEstimate: 120_000n,
        exactOutput: false,
      };
    }

    const exactOut = mode === "recipient_receives";
    const fixed = parseUnits(amount, exactOut ? receiveToken.decimals : payToken.decimals);
    if (fixed <= 0n) {
      return { ok: false, code: "invalid_amount", message: "Enter an amount greater than zero." };
    }

    const best = await this.findBestPath(payToken, receiveToken, fixed, exactOut);
    if (!best) {
      return {
        ok: false,
        code: "route_unavailable",
        message: "No supported liquidity route can currently satisfy this payment.",
        alternatives: await this.reachableSymbols(payToken, [receiveToken]),
      };
    }

    const hops = await this.resolveHops(best.path, best.fees);
    const quoted = await this.quotePath(best.path, best.fees, fixed, exactOut);
    if (!hops || quoted === null) {
      return {
        ok: false,
        code: "route_unavailable",
        message: "No supported liquidity route can currently satisfy this payment.",
        alternatives: await this.reachableSymbols(payToken, [receiveToken]),
      };
    }

    const payAmount = exactOut ? quoted : fixed;
    const receiveAmount = exactOut ? fixed : quoted;

    const payStr = formatUnits(payAmount, payToken.decimals);
    const receiveStr = formatUnits(receiveAmount, receiveToken.decimals);
    const rate = Number(payAmount) > 0 ? Number(receiveAmount) / Number(payAmount) : 0;

    const route: Route = {
      kind: "swap",
      hops,
      path: best.path.map((t) => t.symbol),
      tokens: best.path,
    };

    return {
      ok: true,
      route,
      payAmount: payStr,
      receiveAmount: receiveStr,
      rate,
      gasEstimate: 60_000n + BigInt(hops.length) * 120_000n,
      exactOutput: exactOut,
    };
  }

  async priceUsd(token: TokenConfig): Promise<UsdPrice> {
    const key = poolKey(token);
    const cached = this.priceCache.get(key);
    if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.value;
    const value = await this.computePrice(token);
    this.priceCache.set(key, { value, at: Date.now() });
    return value;
  }

  /**
   * Price a token in dollars.
   *
   * Order of attack:
   *   1. a configured USD anchor is $1 (an explicit peg assumption),
   *   2. a real *market* source (Alchemy / GeckoTerminal / DexScreener) when it
   *      covers the token,
   *   3. otherwise derive the price from live Uniswap V3 liquidity against an
   *      anchor — this is what prices a brand-new token that no market-data
   *      provider knows about yet,
   *   4. a shipped reference price for known assets, else 0 (unknown).
   */
  private async computePrice(token: TokenConfig): Promise<UsdPrice> {
    if (isUsdAnchor(token)) return { usd: 1, source: "stable" };

    const market = await getMarketPriceUsd(token, this.network).catch(() => null);
    if (market) return { usd: market.usd, source: market.source };

    const stables = [...USD_ANCHOR_SYMBOLS]
      .map((s) => getToken(s))
      .filter((t): t is TokenConfig => Boolean(t))
      .filter((t) => !eq(t.address, token.address));

    const probeUnits = parseUnits("1", token.decimals);

    for (const stable of stables) {
      const best = await this.findBestPath(token, stable, probeUnits, false).catch(() => null);
      if (!best) continue;
      const out = await this.quotePath(best.path, best.fees, probeUnits, false).catch(() => null);
      if (out && out > 0n) {
        return { usd: Number(formatUnits(out, stable.decimals)), source: "onchain" };
      }
    }

    if (token.fallbackUsd > 0) return { usd: token.fallbackUsd, source: "fallback" };
    return { usd: 0, source: "fallback" };
  }

  /**
   * Symbols reachable *from a given token* over the current pool graph.
   *
   * This is what "available alternatives" should mean: a token that merely has
   * liquidity somewhere is not necessarily payable from the asset the sender
   * holds. Offering such a token would send the user into another dead end, so
   * reachability — not mere pool existence — decides the list.
   */
  private async reachableSymbols(from: TokenConfig, exclude: TokenConfig[] = []): Promise<string[]> {
    if (!this.graph) {
      await this.ensureGraph(this.seedTokens().filter((t) => t.seed));
    }
    const adjacency = this.graph?.adjacency;
    if (!adjacency) return [];
    const excluded = new Set([from, ...exclude].map((t) => poolKey(t)));
    const start = poolKey(from);
    const seen = new Set<string>([start]);
    const queue: string[] = [start];
    const symbols = new Set<string>();
    while (queue.length) {
      const key = queue.shift()!;
      for (const edge of adjacency.get(key) ?? []) {
        const next = edge.to.toLowerCase();
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
        const t = this.tokenByKey.get(next);
        if (t && !excluded.has(next)) symbols.add(t.symbol);
      }
    }
    return [...symbols].sort();
  }

  async availableSymbols(): Promise<string[]> {
    const cached = this.availCache.get(this.network);
    if (cached && Date.now() - cached.at < GRAPH_TTL_MS) return cached.value;
    if (!this.graph) {
      // Build a graph from the default basis so the list is meaningful.
      await this.ensureGraph(this.seedTokens().filter((t) => t.seed));
    }
    const symbols: string[] = [];
    for (const [k, edges] of this.graph?.adjacency ?? []) {
      if (edges.length === 0) continue;
      const t = this.tokenByKey.get(k);
      if (t) symbols.push(t.symbol);
    }
    const value = [...new Set(symbols)].sort();
    this.availCache.set(this.network, { value, at: Date.now() });
    return value;
  }

  /** Pool keys that currently have at least one liquid pool. */
  async routableKeys(): Promise<Set<string>> {
    if (!this.graph) {
      await this.ensureGraph(this.seedTokens().filter((t) => t.seed));
    }
    const out = new Set<string>();
    for (const [k, edges] of this.graph?.adjacency ?? []) if (edges.length > 0) out.add(k);
    return out;
  }

  /**
   * Routability for every token the app knows about, keyed by both the token's
   * contract address and its pool address (native MON -> WMON).
   *
   * Only tokens that were actually probed are reported. A token that is not in
   * this map is *unknown*, not "not payable" — the honest answer for it comes
   * from attempting a real quote, never from absence in a cache.
   */
  async routability(): Promise<Map<string, boolean>> {
    if (!this.graph) {
      await this.ensureGraph(this.seedTokens().filter((t) => t.seed));
    }
    const adjacency = this.graph?.adjacency ?? new Map<string, PoolInfo[]>();
    const out = new Map<string, boolean>();
    for (const token of allTokens()) {
      const pool = poolKey(token);
      const probed = this.graph?.basisKeys.has(pool) ?? false;
      if (!probed) continue;
      const liquid = (adjacency.get(pool)?.length ?? 0) > 0;
      out.set(token.address.toLowerCase(), liquid);
      out.set(pool, liquid);
    }
    return out;
  }

  /** A token has a route if it participates in at least one liquid pool. */
  async isRoutable(token: TokenConfig): Promise<boolean> {
    if (!this.graph) {
      await this.ensureGraph(this.seedTokens().filter((t) => t.seed));
    }
    const edges = this.graph?.adjacency.get(poolKey(token));
    return Boolean(edges && edges.length > 0);
  }
}
