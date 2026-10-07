import { createPublicClient, http, type PublicClient } from "viem";
import { monadMainnet, monadTestnet, serverRpcUrl, type MonadNetwork } from "@/lib/config/chains";

const cache = new Map<string, PublicClient>();

/**
 * Server-side public client for a Monad network (cached for the process).
 * Uses Alchemy when `ALCHEMY_API_KEY` is set, else the configured/public RPC.
 */
export function getPublicClient(network: MonadNetwork): PublicClient {
  const key = network;
  const existing = cache.get(key);
  if (existing) return existing;

  const client = createPublicClient({
    chain: network === "mainnet" ? monadMainnet : monadTestnet,
    transport: http(serverRpcUrl(network), { timeout: 20_000, retryCount: 2 }),
  });
  cache.set(key, client);
  return client;
}
