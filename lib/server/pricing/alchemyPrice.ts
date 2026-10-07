import type { MonadNetwork } from "@/lib/config/chains";
import { fetchWithTimeout, TtlCache } from "@/lib/server/http";
import type { PriceProvider, PriceQuery } from "./types";

/**
 * Alchemy Prices API (by contract address).
 *
 * Docs: https://www.alchemy.com/docs/reference/prices-api-quickstart
 * Alchemy supports Monad mainnet/testnet, so this is a legitimate *market* price
 * source for Monad tokens (not a DEX-derived one). Enabled only when an API key
 * is configured; returns null on any miss so the resolver can fall through.
 */
const TTL_MS = 45 * 1000;
const cache = new TtlCache<string, number | null>(TTL_MS);

type AlchemyResponse = {
  data?: {
    network?: string;
    address?: string;
    prices?: { currency?: string; value?: string; lastUpdatedAt?: string }[];
    error?: unknown;
  }[];
};

function networkSlug(network: MonadNetwork): string {
  return network === "mainnet" ? "monad-mainnet" : "monad-testnet";
}

export class AlchemyPriceProvider implements PriceProvider {
  readonly name = "alchemy";

  enabled(_network: MonadNetwork): boolean {
    return Boolean(process.env.ALCHEMY_API_KEY);
  }

  async price(q: PriceQuery): Promise<number | null> {
    const key = process.env.ALCHEMY_API_KEY;
    if (!key) return null;
    const cacheKey = `alchemy:${q.network}:${q.poolAddress.toLowerCase()}`;
    return cache.get(cacheKey, async () => {
      try {
        const res = await fetchWithTimeout(
          "https://api.g.alchemy.com/prices/v1/tokens/by-address",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              addresses: [
                { network: networkSlug(q.network), address: q.poolAddress.toLowerCase() },
              ],
            }),
            timeoutMs: 6000,
          },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as AlchemyResponse;
        const entry = json.data?.[0];
        const usd = entry?.prices?.find((p) => (p.currency ?? "USD").toUpperCase() === "USD");
        const value = usd ? Number(usd.value) : NaN;
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    });
  }
}
