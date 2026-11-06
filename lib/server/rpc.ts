import { createPublicClient, http, type PublicClient } from "viem";
import { monadMainnet, serverRpcUrls, type MonadNetwork } from "@/lib/config/chains";
import { receiptFailoverTransport } from "@/lib/rpc/receiptFailover";

const cache = new Map<string, PublicClient>();

/**
 * Server-side public client for Monad Mainnet (cached for the process).
 *
 * The configured Alchemy node is preferred, but a public Monad RPC is always
 * included as a fallback transport. Without it, a rate-limited or unavailable
 * keyed endpoint made every pool read fail, which the router then reported as
 * "no route" — a transient infrastructure fault disguised as a market fact.
 *
 * `receiptFailoverTransport` keeps the configured order (Alchemy first) and the
 * normal fail-over-on-error behaviour, and additionally reads a transaction
 * receipt from whichever endpoint actually has it. A keyed endpoint that answers
 * `eth_getTransactionReceipt` with `null` (not indexed yet) must not make
 * settlement verification give up while the public node already holds it.
 */
export function getPublicClient(_network: MonadNetwork = "mainnet"): PublicClient {
  const existing = cache.get("mainnet");
  if (existing) return existing;

  const client = createPublicClient({
    chain: monadMainnet,
    transport: receiptFailoverTransport(
      serverRpcUrls().map((url) => http(url, { timeout: 20_000, retryCount: 1 })),
    ),
  });
  cache.set("mainnet", client);
  return client;
}
