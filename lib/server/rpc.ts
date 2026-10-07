import { createPublicClient, http, type PublicClient } from "viem";
import { monadMainnet, serverRpcUrl, type MonadNetwork } from "@/lib/config/chains";

const cache = new Map<string, PublicClient>();

/**
 * Server-side public client for Monad Mainnet (cached for the process).
 * Uses Alchemy when `ALCHEMY_API_KEY` is set, else the configured/public RPC.
 */
export function getPublicClient(_network: MonadNetwork = "mainnet"): PublicClient {
  const existing = cache.get("mainnet");
  if (existing) return existing;

  const client = createPublicClient({
    chain: monadMainnet,
    transport: http(serverRpcUrl(), { timeout: 20_000, retryCount: 2 }),
  });
  cache.set("mainnet", client);
  return client;
}
