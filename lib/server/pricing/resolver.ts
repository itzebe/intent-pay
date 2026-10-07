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
  /** Freshness of the price, so callers can distinguish live data from stale. */
  status: PriceStatus;
};

/**
 * Price freshness.
 *   LIVE        — resolved within its TTL
 *   STALE       — a real price, but older than its TTL (shown with a caveat)
 *   UNAVAILABLE — no trustworthy price (never rendered as $0.00)
 */
export type PriceStatus = "LIVE" | "STALE" | "UNAVAILABLE";

/** Derive the freshness status from a resolved price and the current time. */
export function priceStatus(
  price: Pick<ResolvedPrice, "usd" | "at" | "ttlMs">,
  now = Date.now(),
): PriceStatus {
  if (!(price.usd && price.usd > 0)) return "UNAVAILABLE";
  return now - price.at > price.ttlMs ? "STALE" : "LIVE";
}

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
  /** Last genuine price per key, so a provider outage can serve STALE data. */
  private lastGood = new Map<string, ResolvedPrice>();
  /** How long a last-known-good price may be served as STALE before giving up. */
  private staleGraceMs = 15 * 60 * 1000;

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
    const fresh = await this.cache.get(key, async () => {
      const at = Date.now();

      // A configured USD anchor is $1 by definition of the peg. This is an
      // explicit config assumption, surfaced as such — never a fake quote.
      if (isUsdAnchor(token)) {
        return { usd: 1, source: "stable", label: labelFor("stable"), at, ttlMs: TTL_MS, status: "LIVE" };
      }

      const q = this.query(network, token);
      for (const provider of this.market) {
        if (!provider.enabled(network)) continue;
        const usd = await provider.price(q).catch(() => null);
        if (usd && usd > 0) {
          const kind: PriceSourceKind = provider.name === "alchemy" ? "market" : "dex";
          return { usd, source: kind, label: labelFor(kind), at, ttlMs: TTL_MS, status: "LIVE" };
        }
      }

      // DEX-derived: read the live Uniswap V3 quoter against a USD anchor.
      try {
        const provider = getRoutingProvider(network);
        const onchain = await provider.priceUsd(token, network);
        if (onchain.usd > 0 && onchain.source !== "fallback") {
          return { usd: onchain.usd, source: "onchain", label: labelFor("onchain"), at, ttlMs: TTL_MS, status: "LIVE" };
        }
      } catch {
        /* fall through */
      }

      // No live source resolved a price. Production never substitutes a
      // hardcoded rate here — the token is honestly unpriceable right now.
      return { usd: null, source: "unavailable", label: labelFor("unavailable"), at, ttlMs: TTL_MS, status: "UNAVAILABLE" };
    });

    if (fresh.usd && fresh.usd > 0) {
      this.lastGood.set(key, fresh);
      return fresh;
    }

    // Fresh resolution found nothing. If we priced this token recently, serve
    // the last-known value explicitly as STALE rather than showing "unavailable"
    // just because a provider is momentarily down.
    const prev = this.lastGood.get(key);
    if (prev && Date.now() - prev.at <= this.staleGraceMs) {
      return { ...prev, status: "STALE" };
    }
    return fresh;
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
