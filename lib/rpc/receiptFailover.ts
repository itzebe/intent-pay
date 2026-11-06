import { fallback, type EIP1193RequestFn, type Transport } from "viem";

/**
 * A transport that fails over on a transaction *receipt* read.
 *
 * viem's `fallback` only tries the next endpoint when one *throws*. A node that
 * answers `eth_getTransactionReceipt` with `null` — a healthy endpoint that has
 * not indexed the receipt yet — is a successful call, so `fallback` returns that
 * `null` and stops. Every other endpoint is never asked.
 *
 * That is a real hang, not a theoretical one: `waitForTransactionReceipt` polls
 * the first endpoint until its 90 s timeout even though a later endpoint already
 * has the receipt. It left the composer stuck on "Wrap MON for the route" after
 * the wallet had actually wrapped, and the customer checkout stuck on
 * "Transaction submitted — confirming on-chain" forever.
 *
 * A receipt read therefore tries each endpoint in turn and only accepts a
 * non-null answer. Every other method keeps the normal `fallback` behaviour
 * (retry the next endpoint on a thrown error). Kept free of any client/React
 * import so both the browser client and the server client share one rule.
 */
export function receiptFailoverTransport(transports: Transport[]): Transport {
  return (config) => {
    const base = fallback(transports, { rank: false, retryCount: 1 })(config);
    const endpoints = transports.map((transport) => transport(config));
    return {
      ...base,
      // The base transport's request signature is generic; the override returns a
      // concrete receipt-or-null, so the cast is confined to this one call.
      request: (async (args) => {
        if (args?.method === "eth_getTransactionReceipt") {
          for (const endpoint of endpoints) {
            try {
              const receipt = await endpoint.request(args);
              // A non-null receipt from any endpoint is authoritative; a `null`
              // only means *that* endpoint has not indexed it yet.
              if (receipt) return receipt;
            } catch {
              // This endpoint could not answer — try the next before giving up.
            }
          }
          return null;
        }
        return base.request(args);
      }) as EIP1193RequestFn,
    };
  };
}
