"use client";

import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { NETWORKS, browserRpcUrls, type MonadNetwork } from "@/lib/config/chains";

const cache = new Map<MonadNetwork, PublicClient>();

/**
 * Browser-side public client.
 *
 * The configured keyed provider is preferred, but the public Monad RPC is always
 * a fallback transport. A receipt wait (`waitForTransactionReceipt`) or a
 * balance read against a rate-limited keyed endpoint would otherwise fail the
 * whole confirmation on a mobile connection, even though the transaction is
 * already on chain.
 */
export function getClientPublicClient(network: MonadNetwork): PublicClient {
  const existing = cache.get(network);
  if (existing) return existing;
  const net = NETWORKS[network];
  const client = createPublicClient({
    chain: net.chain,
    transport: fallback(
      browserRpcUrls(network).map((url) => http(url, { timeout: 20_000, retryCount: 1 })),
      { rank: false, retryCount: 1 },
    ),
  });
  cache.set(network, client);
  return client;
}
