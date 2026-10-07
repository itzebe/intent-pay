import type { MonadNetwork } from "@/lib/config/chains";
import { isUsdAnchor, poolAddressOf, type TokenConfig } from "@/lib/config/tokens";
import { getRoutingProvider } from "@/lib/providers";
import { TtlCache } from "@/lib/server/http";
import { marketProviders } from "./market";
import type { PriceProvider, PriceQuery } from "./types";

/**
 * Where a resolved price came from. Kept honest end-to-end so the UI can show
 * "Market" vs "DEX" vs "Unavailable" instead of a bare number.
 *   - "stable"  — the token is a configured $1 peg (an assumption, not a quote)
 *   - "market"  — a market-data source (Alchemy Prices API)
 *   - "dex"     — a public DEX aggregator (GeckoTerminal / DexScreener)
 *   - "onchain" — derived from live Uniswap V3 pool liquidity
 *   - "fallback"— a shipped reference price (demo/known default)
 */
export type PriceSourceKind = "stable" | "market" | "dex" | "onchain" | "fallback" | "unavailable";

export type ResolvedPrice = {
  usd: number | null;
  source: PriceSourceKind;
  /** Human label for the UI, e.g. "Market price" / "DEX price". */
  label: string;
  /** When this price was resolved (ms). */
  at: number;
  /** How long the resolver considers it fresh. */
  ttlMs: number;
};

const TTL_MS = 45 * 1000;

const labelFor = (kind: PriceSourceKind): string => {
  switch (kind) {
    case "stable":
      return "Stablecoin peg";
    case "market":
      return "Market price";
    case "dex":
      return "DEX price";
    case "onchain":
      return "On-chain DEX price";
    case "fallback":
      return "Reference price";
    default:
      return "Price unavailable";
  }
};

/**
 * Real price-resolution layer.
 *
 * Order of attack for a token that is not a configured USD anchor:
 *   1. primary market-data source (Alchemy Prices API, when configured)
 *   2. fallback market-data source (GeckoTerminal, then DexScreener)
 *   3. DEX-derived reference price from live Uniswap V3 liquidity
 *   4. unavailable — never a fabricated value
 *
 * The resolver never returns 0 for an unknown token; it returns null with
 * source "unavailable", which the UI renders as "Price unavailable".
 */
export class PriceResolver {
  private market: PriceProvider[];
  private cache: TtlCache<string, ResolvedPrice>;

  constructor(market: PriceProvider[] = marketProviders) {
    this.market = market;
    this.cache = new TtlCache(TTL_MS);
  }

  private query(network: MonadNetwork, token: TokenConfig): PriceQuery {
    return { network, token, poolAddress: poolAddressOf(token) };
  }

  /** Resolve a USD price, trying each layer in order. */
  async resolve(token: TokenConfig, network: MonadNetwork = "mainnet"): Promise<ResolvedPrice> {
    const key = `${network}:${poolAddressOf(token)}`;
    return this.cache.get(key, async () => {
      const at = Date.now();

      // A configured USD anchor is $1 by definition of the peg. This is an
      // explicit config assumption, surfaced as such — never a fake quote.
      if (isUsdAnchor(token)) {
        return { usd: 1, source: "stable", label: labelFor("stable"), at, ttlMs: TTL_MS };
      }

      const q = this.query(network, token);
      for (const provider of this.market) {
        if (!provider.enabled(network)) continue;
        const usd = await provider.price(q).catch(() => null);
        if (usd && usd > 0) {
          const kind: PriceSourceKind = provider.name === "alchemy" ? "market" : "dex";
          return { usd, source: kind, label: labelFor(kind), at, ttlMs: TTL_MS };
        }
      }

      // DEX-derived: read the live Uniswap V3 quoter against a USD anchor.
      try {
        const provider = getRoutingProvider("live", network);
        const onchain = await provider.priceUsd(token, network);
        if (onchain.usd > 0 && onchain.source !== "fallback") {
          return { usd: onchain.usd, source: "onchain", label: labelFor("onchain"), at, ttlMs: TTL_MS };
        }
      } catch {
        /* fall through */
      }

      // A shipped reference price is still legitimate for known assets — but it
      // is labelled as such, and unknown tokens get nothing.
      if (token.fallbackUsd > 0) {
        return { usd: token.fallbackUsd, source: "fallback", label: labelFor("fallback"), at, ttlMs: TTL_MS };
      }

      return { usd: null, source: "unavailable", label: labelFor("unavailable"), at, ttlMs: TTL_MS };
    });
  }

  /** Convenience for callers that only need the number (null when unknown). */
  async usd(token: TokenConfig, network: MonadNetwork = "mainnet"): Promise<number | null> {
    return (await this.resolve(token, network)).usd;
  }
}

let singleton: PriceResolver | null = null;
export function getPriceResolver(): PriceResolver {
  if (!singleton) singleton = new PriceResolver();
  return singleton;
}
