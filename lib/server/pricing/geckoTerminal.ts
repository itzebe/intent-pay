import type { MonadNetwork } from "@/lib/config/chains";
import { fetchWithTimeout, TtlCache } from "@/lib/server/http";
import { MIN_TRUSTED_LIQUIDITY_USD, type PriceProvider, type PriceQuery } from "./types";

/**
 * GeckoTerminal public API — keyless DEX market data that supports Monad.
 *
 * Returns an aggregated USD price plus total pool reserve; we refuse to trust a
 * price whose backing liquidity is below MIN_TRUSTED_LIQUIDITY_USD, so a token
 * with only a microscopic pool resolves as "unavailable" rather than mispriced.
 */
const TTL_MS = 45 * 1000;
const cache = new TtlCache<string, number | null>(TTL_MS);

type GtResponse = {
  data?: {
    attributes?: {
      price_usd?: string | null;
      total_reserve_in_usd?: string | null;
    };
  };
};

export class GeckoTerminalPriceProvider implements PriceProvider {
  readonly name = "geckoterminal";

  enabled(_network: MonadNetwork): boolean {
    return true;
  }

  async price(q: PriceQuery): Promise<number | null> {
    const networkId = process.env.GECKOTERMINAL_NETWORK ?? "monad";
    const cacheKey = `gt:${networkId}:${q.poolAddress.toLowerCase()}`;
    return cache.get(cacheKey, async () => {
      try {
        const res = await fetchWithTimeout(
          `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${q.poolAddress.toLowerCase()}`,
          { headers: { accept: "application/json" }, timeoutMs: 6000 },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as GtResponse;
        const attrs = json.data?.attributes;
        const price = attrs?.price_usd ? Number(attrs.price_usd) : NaN;
        const liquidity = attrs?.total_reserve_in_usd
          ? Number(attrs.total_reserve_in_usd)
          : 0;
        if (!Number.isFinite(price) || price <= 0) return null;
        if (Number.isFinite(liquidity) && liquidity > 0 && liquidity < MIN_TRUSTED_LIQUIDITY_USD) {
          return null;
        }
        return price;
      } catch {
        return null;
      }
    });
  }
}
