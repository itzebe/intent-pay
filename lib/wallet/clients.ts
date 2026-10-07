"use client";

import { createPublicClient, http, type PublicClient } from "viem";
import { NETWORKS, browserRpcUrl, type MonadNetwork } from "@/lib/config/chains";

const cache = new Map<MonadNetwork, PublicClient>();

export function getClientPublicClient(network: MonadNetwork): PublicClient {
  const existing = cache.get(network);
  if (existing) return existing;
  const net = NETWORKS[network];
  const client = createPublicClient({
    chain: net.chain,
    transport: http(browserRpcUrl(network), { timeout: 20_000 }),
  });
  cache.set(network, client);
  return client;
}
