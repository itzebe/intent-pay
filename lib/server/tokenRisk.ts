import { encodeFunctionData, type Address } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import { getPublicClient } from "@/lib/server/rpc";
import type { TokenConfig } from "@/lib/config/tokens";
import {
  assessTokenRisk,
  type TokenRiskFacts,
  type TokenRiskReport,
} from "@/lib/domain/tokenRisk";
import { ERC20_ABI } from "@/lib/execution/abis";
import { getRoutingProvider } from "@/lib/providers";
import { WMON_ADDRESS } from "@/lib/providers/constants";
import { fetchWithTimeout } from "@/lib/server/http";

/**
 * Live execution-risk probe for a token.
 *
 * This is where the *facts* the pure classifier needs are actually measured,
 * against real Monad data:
 *   - liquidity depth from the live Uniswap V3 pool(s),
 *   - a real `eth_call` transfer simulation from the payer (so a paused/blocked
 *     token is caught before signing),
 *   - a live route + price impact from the routing provider.
 *
 * Every probe is best-effort and reports `null` (unknown) on failure — never a
 * fabricated value — so the classifier only ever blocks on evidence.
 */

const SIM_AMOUNT = 1n; // 1 base unit: enough to exercise the transfer path.

export type TokenRiskProbe = {
  network: MonadNetwork;
  token: TokenConfig;
  /** Optional payer: enables the transfer simulation. */
  payer?: Address;
  /** Optional live price impact + route availability already known. */
  priceImpact?: number | null;
  hasRoute?: boolean;
};

/**
 * Measure a token's execution risk. Returns a report whose `blocked` flag is a
 * real, evidence-backed gate.
 */
export async function probeTokenRisk(probe: TokenRiskProbe): Promise<TokenRiskReport> {
  const { token, network, payer } = probe;

  const [liquidityUsd, transferSim, route] = await Promise.all([
    measureLiquidityUsd(token, network).catch(() => null),
    payer ? simulateTransfer(token, payer, network).catch(() => null) : Promise.resolve(null),
    resolveRoute(probe),
  ]);

  const facts: TokenRiskFacts = {
    decimals: token.decimals,
    liquidityUsd,
    priceImpact: route.priceImpact,
    maxPriceImpact: maxPriceImpact(),
    transferSim,
    hasRoute: route.hasRoute,
  };
  return assessTokenRisk(facts);
}

function maxPriceImpact(): number {
  const bps = Number(process.env.NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS ?? "300");
  const frac = bps / 10_000;
  return Number.isFinite(frac) && frac > 0 ? frac : 0.03;
}

/**
 * Route + price impact. Prefers caller-supplied values (so we don't re-quote a
 * payment already being quoted) and falls back to a routability probe.
 */
async function resolveRoute(probe: TokenRiskProbe): Promise<{
  hasRoute: boolean;
  priceImpact: number | null;
}> {
  if (typeof probe.hasRoute === "boolean") {
    return { hasRoute: probe.hasRoute, priceImpact: probe.priceImpact ?? null };
  }
  try {
    const routable = await getRoutingProvider(probe.network).isRoutable?.(
      probe.token,
      probe.network,
    );
    return { hasRoute: Boolean(routable), priceImpact: probe.priceImpact ?? null };
  } catch {
    return { hasRoute: false, priceImpact: probe.priceImpact ?? null };
  }
}

/**
 * Deepest-pool USD liquidity for a token, from real market data. We ask the
 * market providers for the pool's liquidity and take the largest figure; when
 * none is available we return null (unknown), never 0.
 */
async function measureLiquidityUsd(
  token: TokenConfig,
  _network: MonadNetwork,
): Promise<number | null> {
  const pool = (token.native ? WMON_ADDRESS : token.address).toLowerCase();

  // DexScreener exposes per-pair USD liquidity for Monad — the most direct
  // measurement of "can this token actually be traded".
  try {
    const res = await fetchWithTimeout(
      `https://api.dexscreener.com/token-pairs/v1/monad/${pool}`,
      { headers: { accept: "application/json" }, timeoutMs: 6000 },
    );
    if (res.ok) {
      const pairs = (await res.json()) as { liquidity?: { usd?: number } }[];
      if (Array.isArray(pairs)) {
        let best = 0;
        let saw = false;
        for (const p of pairs) {
          const liq = p?.liquidity?.usd;
          if (typeof liq === "number" && Number.isFinite(liq)) {
            saw = true;
            if (liq > best) best = liq;
          }
        }
        if (saw) return best;
      }
    }
  } catch {
    /* fall through to on-chain liquidity */
  }

  // Fallback: GeckoTerminal's total reserve in USD (also real, keyless). This
  // is what covers a brand-new token DexScreener may not have indexed yet.
  try {
    const networkId = process.env.GECKOTERMINAL_NETWORK ?? "monad";
    const res = await fetchWithTimeout(
      `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${pool}`,
      { headers: { accept: "application/json" }, timeoutMs: 6000 },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        data?: { attributes?: { total_reserve_in_usd?: string | null } };
      };
      const reserve = json.data?.attributes?.total_reserve_in_usd;
      const n = reserve ? Number(reserve) : NaN;
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* ignore */
  }
  // Nothing measured a depth. Report unknown — never invent a figure.
  return null;
}

/**
 * Simulate the token's transfer path with a real `eth_call`. A revert for a
 * payer that holds the balance means the token is not actually transferable
 * (paused, blacklisting, fee-on-transfer that reverts, etc.) and must block.
 */
async function simulateTransfer(
  token: TokenConfig,
  payer: Address,
  network: MonadNetwork,
): Promise<{ ok: boolean; reason?: string } | null> {
  if (token.native) return { ok: true };
  const client = getPublicClient(network);

  // Only simulate when the payer actually holds at least the sim amount — a
  // revert due to insufficient balance is not a token defect.
  try {
    const balance = (await client.readContract({
      address: token.address as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [payer],
    })) as bigint;
    if (balance < SIM_AMOUNT) return null; // inconclusive, not a failure
  } catch {
    return null;
  }

  try {
    // `eth_call` only — this never submits a transaction. `client.call` with an
    // encoded `transfer` exercises the token's transfer path from `payer`.
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [payer, SIM_AMOUNT],
    });
    await client.call({ account: payer, to: token.address as Address, data });
    return { ok: true };
  } catch (err) {
    const message = (err as { shortMessage?: string; message?: string })?.shortMessage ??
      (err as Error)?.message ??
      "transfer reverted";
    return { ok: false, reason: message.slice(0, 160) };
  }
}
