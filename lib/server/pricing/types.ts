import type { MonadNetwork } from "@/lib/config/chains";
import type { TokenConfig } from "@/lib/config/tokens";

/**
 * A price lookup for one token on one network. `poolAddress` is the address the
 * DEXs actually key on (WMON for the native asset), so a market source and an
 * on-chain pool always agree on *which* asset is being priced.
 */
export type PriceQuery = {
  network: MonadNetwork;
  token: TokenConfig;
  poolAddress: string;
};

/**
 * A market-data source. Implementations must return `null` — never a guessed or
 * zero value — when they cannot price the token. The resolver treats `null` as
 * "try the next source".
 */
export interface PriceProvider {
  readonly name: string;
  /** True when configuration (keys) and the target network allow this source. */
  enabled(network: MonadNetwork): boolean;
  /** USD price, or null when this source cannot price the token. */
  price(q: PriceQuery): Promise<number | null>;
}

/**
 * Pools below this depth are treated as untrustworthy for pricing. A token with
 * only a microscopic pool is far more likely to be mispriced (or manipulated)
 * than to have a real market, so we prefer "price unavailable" over a bad price.
 */
export const MIN_TRUSTED_LIQUIDITY_USD = 2_000;
