import type { MonadNetwork } from "@/lib/config/chains";
import { DemoProvider } from "./demo";
import { UniswapV3Provider } from "./uniswapV3";
import type { RoutingProvider } from "./types";

export type AppMode = "live" | "demo";

const liveProviders = new Map<MonadNetwork, UniswapV3Provider>();
const demoProvider = new DemoProvider();

/**
 * Returns the routing provider for a mode. Providers are stateless w.r.t. the
 * UI; swapping the routing backend never touches UI code.
 */
export function getRoutingProvider(mode: AppMode, network: MonadNetwork = "mainnet"): RoutingProvider {
  if (mode === "demo") return demoProvider;
  let p = liveProviders.get(network);
  if (!p) {
    p = new UniswapV3Provider(network);
    liveProviders.set(network, p);
  }
  return p;
}

export { DemoProvider, UniswapV3Provider };
export type { RoutingProvider };
