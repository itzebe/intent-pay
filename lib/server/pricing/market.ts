import type { MonadNetwork } from "@/lib/config/chains";
import { poolAddressOf, type TokenConfig } from "@/lib/config/tokens";
import { AlchemyPriceProvider } from "./alchemyPrice";
import { GeckoTerminalPriceProvider } from "./geckoTerminal";
import { DexScreenerPriceProvider } from "./dexscreener";
import type { PriceProvider } from "./types";

/**
 * Market-data-only price lookup (Alchemy -> GeckoTerminal -> DexScreener).
 *
 * Deliberately free of any dependency on the routing layer, so the Uniswap
 * provider can consult *market* prices without creating a resolver<->router
 * cycle (the resolver's on-chain step calls the router; the router must not call
 * the resolver back).
 *
 * The provider instances are module singletons so their TTL caches are shared
 * between the resolver and the router — one network call, not two.
 */
export const marketProviders: PriceProvider[] = [
  new AlchemyPriceProvider(),
  new GeckoTerminalPriceProvider(),
  new DexScreenerPriceProvider(),
];

export type MarketPrice = { usd: number; source: "market" | "dex"; provider: string };

export async function getMarketPriceUsd(
  token: TokenConfig,
  network: MonadNetwork = "mainnet",
): Promise<MarketPrice | null> {
  const q = { network, token, poolAddress: poolAddressOf(token) };
  for (const provider of marketProviders) {
    if (!provider.enabled(network)) continue;
    const usd = await provider.price(q).catch(() => null);
    if (usd && usd > 0) {
      return {
        usd,
        source: provider.name === "alchemy" ? "market" : "dex",
        provider: provider.name,
      };
    }
  }
  return null;
}
