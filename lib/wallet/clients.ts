"use client";

import { createPublicClient, http, type PublicClient } from "viem";
import { NETWORKS, browserRpcUrls, type MonadNetwork } from "@/lib/config/chains";
import { receiptFailoverTransport } from "@/lib/rpc/receiptFailover";

const cache = new Map<MonadNetwork, PublicClient>();

/**
 * Browser-side public client.
 *
 * The configured keyed provider is preferred, but the public Monad RPC is always
 * a fallback transport. A receipt wait (`waitForTransactionReceipt`) or a
 * balance read against a rate-limited keyed endpoint would otherwise fail the
 * whole confirmation on a mobile connection, even though the transaction is
 * already on chain. Receipt reads additionally fail over across *every*
 * endpoint (see `lib/rpc/receiptFailover`), so one node that never indexes a
 * receipt cannot hang the payment.
 */
export function getClientPublicClient(network: MonadNetwork): PublicClient {
  const existing = cache.get(network);
  if (existing) return existing;
  const net = NETWORKS[network];
  const client = createPublicClient({
    chain: net.chain,
    transport: receiptFailoverTransport(
      browserRpcUrls(network).map((url) => http(url, { timeout: 20_000, retryCount: 1 })),
    ),
  });
  cache.set(network, client);
  return client;
}
