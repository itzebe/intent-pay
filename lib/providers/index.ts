import type { MonadNetwork } from "@/lib/config/chains";
import { UniswapV3Provider } from "./uniswapV3";
import type { RoutingProvider } from "./types";

/**
 * The routing layer is mainnet-only and live-only. Production never has a
 * simulated routing backend: every quote comes from the real Uniswap V3
 * deployment on Monad Mainnet. `getRoutingProvider()` exists so the UI never
 * imports a concrete provider.
 */
const providers = new Map<MonadNetwork, UniswapV3Provider>();

export function getRoutingProvider(network: MonadNetwork = "mainnet"): RoutingProvider {
  let p = providers.get(network);
  if (!p) {
    p = new UniswapV3Provider(network);
    providers.set(network, p);
  }
  return p;
}

export { UniswapV3Provider };
export type { RoutingProvider };
