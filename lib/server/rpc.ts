import { createPublicClient, http, type PublicClient } from "viem";
import { monadMainnet, monadTestnet, type MonadNetwork } from "@/lib/config/chains";

const cache = new Map<string, PublicClient>();

/** Server-side public client for a Monad network (cached per request lifecycle). */
export function getPublicClient(network: MonadNetwork): PublicClient {
  const key = network;
  const existing = cache.get(key);
  if (existing) return existing;

  const rpc =
    network === "mainnet"
      ? process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz"
      : process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz";

  const client = createPublicClient({
    chain: network === "mainnet" ? monadMainnet : monadTestnet,
    transport: http(rpc, { timeout: 20_000, retryCount: 2 }),
  });
  cache.set(key, client);
  return client;
}
