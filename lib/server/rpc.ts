import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { monadMainnet, serverRpcUrls, type MonadNetwork } from "@/lib/config/chains";

const cache = new Map<string, PublicClient>();

/**
 * Server-side public client for Monad Mainnet (cached for the process).
 *
 * The configured Alchemy node is preferred, but a public Monad RPC is always
 * included as a fallback transport. Without it, a rate-limited or unavailable
 * keyed endpoint made every pool read fail, which the router then reported as
 * "no route" — a transient infrastructure fault disguised as a market fact.
 *
 * `rank: false` keeps the configured order (Alchemy first); viem still fails
 * over to the public node on an error and then sticks with the transport that
 * last succeeded.
 */
export function getPublicClient(_network: MonadNetwork = "mainnet"): PublicClient {
  const existing = cache.get("mainnet");
  if (existing) return existing;

  const client = createPublicClient({
    chain: monadMainnet,
    transport: fallback(
      serverRpcUrls().map((url) => http(url, { timeout: 20_000, retryCount: 1 })),
      { rank: false, retryCount: 1 },
    ),
  });
  cache.set("mainnet", client);
  return client;
}
