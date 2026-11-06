import { createTransport, type EIP1193RequestFn, type Transport } from "viem";

/**
 * How long a failed endpoint is skipped before it is tried again.
 *
 * A node that has just stalled (a dropped packet, a hung connection) is not
 * worth re-trying on the next read: doing so pays its timeout again on every
 * subsequent call in the same request, and a route performs several reads. The
 * breaker remembers the failure for a short cooldown and routes straight to the
 * next endpoint, so only the first read pays the stall.
 */
export const ENDPOINT_COOLDOWN_MS = 15_000;

/**
 * Per-request timeout for every application-owned RPC endpoint.
 *
 * A healthy Monad node answers a single read in well under a second (and a
 * 125-call `multicall` in about one). A stalled node throws nothing until its
 * own timeout, so this value is the *only* bound on how long one stalled read
 * can hold a request. It is deliberately short: the previous 20 s meant a
 * route's first read alone could exceed the serverless limit.
 */
export const ENDPOINT_TIMEOUT_MS = 5000;

export type ReceiptFailoverOptions = {
  /** How long a failed endpoint is skipped. Exposed for tests. */
  cooldownMs?: number;
};

/**
 * Ordered failover for the app's own RPC clients.
 *
 * The endpoints are tried in order and the first one to answer wins. Two
 * behaviours matter, and neither is what viem's stock `fallback` gives us:
 *
 *  1. **A stalled endpoint must fail over — once.** `fallback` moves on only
 *     when a call *throws*. A node that accepts the connection but never replies
 *     throws nothing until its own timeout, so a stalled preferred endpoint cost
 *     that timeout on *every* request. On the deployed app this was the
 *     production outage: `/api/balances`, `/api/tokens` and `/api/quote` each
 *     blocked on the keyed endpoint's 20 s timeout and exceeded the serverless
 *     limit, so balances looked empty and a payment could never be prepared.
 *     The endpoints now have a short timeout (`ENDPOINT_TIMEOUT_MS`) and a failed
 *     one is skipped for a cooldown, so a route pays the stall at most once.
 *
 *  2. **A receipt read must fail over even on a `null`.** `fallback` stops at
 *     the first endpoint that answers `eth_getTransactionReceipt` with `null` —
 *     a healthy node that has not indexed the receipt yet — because that is a
 *     successful call. `waitForTransactionReceipt` then polls that one endpoint
 *     until its 90 s timeout while another endpoint already holds the receipt
 *     (the composer stuck on "Wrap MON for the route", the checkout stuck on
 *     "confirming on-chain"). A receipt read therefore tries each endpoint and
 *     only accepts a non-null answer.
 *
 * Failover stays *sequential on purpose*. viem's `http` transport coalesces
 * concurrent requests to one endpoint into a single batched POST, so a 125-call
 * `multicall` becomes one request per endpoint. Racing the endpoints in parallel
 * (a hedge) instead sends 125 concurrent POSTs to the fallback and overruns it —
 * measured against a stalled endpoint, and the reason this is not a hedge.
 *
 * Built with viem's `createTransport` so the transport carries a real `type`
 * and — importantly — `retryCount: 0`. A viem-level retry would re-run the
 * whole ordered attempt and re-hit an endpoint the breaker is cooling down.
 *
 * Kept free of any client/React import so both the browser client and the server
 * client share one rule.
 */
export function receiptFailoverTransport(
  transports: Transport[],
  options: ReceiptFailoverOptions = {},
): Transport {
  const cooldownMs = options.cooldownMs ?? ENDPOINT_COOLDOWN_MS;
  return (config) => {
    // Instantiate the endpoints with retry disabled: this transport owns
    // failover, and the client's default retry count would otherwise multiply
    // every attempt (a stalled endpoint would be hit `1 + retryCount` times).
    const endpointConfig = { ...config, retryCount: 0 };
    const endpoints = transports.map((transport) => transport(endpointConfig));
    // Endpoint index -> epoch ms until which it is skipped after a failure.
    const cooldownUntil = new Map<number, number>();

    const isCoolingDown = (index: number) => (cooldownUntil.get(index) ?? 0) > Date.now();

    const request = (async (args) => {
      if (args?.method === "eth_getTransactionReceipt") {
        // Only a non-null receipt is authoritative; a `null` means *this*
        // endpoint has not indexed it yet, so keep looking.
        for (const endpoint of endpoints) {
          try {
            const receipt = await endpoint.request(args);
            if (receipt) return receipt;
          } catch {
            // This endpoint could not answer — try the next before giving up.
          }
        }
        return null;
      }

      // Prefer endpoints that are not cooling down, but never drop one
      // entirely — if every endpoint is cooling down we still must try them.
      const order = endpoints.map((_, index) => index);
      const preferred = order.filter((index) => !isCoolingDown(index));
      const candidates = preferred.length > 0 ? preferred : order;

      let lastError: unknown;
      for (const index of candidates) {
        try {
          const result = await endpoints[index]!.request(args);
          cooldownUntil.delete(index);
          return result;
        } catch (err) {
          lastError = err;
          cooldownUntil.set(index, Date.now() + cooldownMs);
        }
      }
      throw lastError;
    }) as EIP1193RequestFn;

    return createTransport({
      key: "fallback",
      name: "Failover RPC",
      type: "fallback",
      retryCount: 0,
      request,
    });
  };
}
