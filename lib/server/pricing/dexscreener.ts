import type { MonadNetwork } from "@/lib/config/chains";
import { fetchWithTimeout, TtlCache } from "@/lib/server/http";
import { MIN_TRUSTED_LIQUIDITY_USD, type PriceProvider, type PriceQuery } from "./types";

/**
 * DexScreener public API — keyless DEX market data that supports Monad.
 *
 * DexScreener returns every pair for a token; we take the deepest-liquid pair's
 * USD price. Like GeckoTerminal, we reject prices backed by a pool that is too
 * shallow to trust.
 */
const TTL_MS = 45 * 1000;
const cache = new TtlCache<string, number | null>(TTL_MS);

type Pair = {
  priceUsd?: string;
  liquidity?: { usd?: number };
};

export class DexScreenerPriceProvider implements PriceProvider {
  readonly name = "dexscreener";

  enabled(_network: MonadNetwork): boolean {
    return process.env.DEXSCREENER_ENABLED !== "0";
  }

  async price(q: PriceQuery): Promise<number | null> {
    const cacheKey = `ds:${q.network}:${q.poolAddress.toLowerCase()}`;
    return cache.get(cacheKey, async () => {
      try {
        const res = await fetchWithTimeout(
          `https://api.dexscreener.com/token-pairs/v1/monad/${q.poolAddress.toLowerCase()}`,
          { headers: { accept: "application/json" }, timeoutMs: 6000 },
        );
        if (!res.ok) return null;
        const pairs = (await res.json()) as Pair[];
        if (!Array.isArray(pairs) || pairs.length === 0) return null;

        let best: { price: number; liquidity: number } | null = null;
        for (const p of pairs) {
          const price = p.priceUsd ? Number(p.priceUsd) : NaN;
          const liquidity = p.liquidity?.usd ?? 0;
          if (!Number.isFinite(price) || price <= 0) continue;
          if (!best || liquidity > best.liquidity) best = { price, liquidity };
        }
        if (!best) return null;
        if (best.liquidity > 0 && best.liquidity < MIN_TRUSTED_LIQUIDITY_USD) return null;
        return best.price;
      } catch {
        return null;
      }
    });
  }
}
