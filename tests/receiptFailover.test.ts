import { describe, expect, it } from "vitest";
import { createPublicClient, custom, defineChain } from "viem";
import { receiptFailoverTransport } from "@/lib/rpc/receiptFailover";

/**
 * Receipt-read failover.
 *
 * viem's `fallback` only moves to the next endpoint when a call *throws*. A node
 * that answers `eth_getTransactionReceipt` with `null` — a healthy endpoint that
 * simply has not indexed the receipt yet — is a successful call, so `fallback`
 * returns the `null` and stops. `waitForTransactionReceipt` then polls that one
 * endpoint until its 90 s timeout even though another endpoint already has the
 * receipt. That is the production hang: the composer stuck on "Wrap MON for the
 * route" after the wallet had wrapped, and the checkout stuck on "confirming
 * on-chain" forever.
 *
 * These tests use REAL transports (viem `custom`) so the failover rule itself is
 * exercised, not a mock of it.
 */

const chain = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
});

const HASH = `0x${"a".repeat(64)}` as const;
/** A raw JSON-RPC receipt, exactly as an endpoint returns it (hex quantities). */
const RECEIPT = {
  transactionHash: HASH,
  status: "0x1",
  blockNumber: "0x1",
  blockHash: `0x${"b".repeat(64)}`,
  transactionIndex: "0x0",
  from: `0x${"1".repeat(40)}`,
  to: `0x${"2".repeat(40)}`,
  contractAddress: null,
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x1",
  logs: [],
  logsBloom: `0x${"0".repeat(512)}`,
  type: "0x2",
} as const;

/** A transport that answers a fixed receipt for the receipt method, and a fixed
 *  block number for everything else. */
function endpoint(receipt: unknown, opts: { blockNumber?: string; throwOnReceipt?: boolean } = {}) {
  const requests: string[] = [];
  const transport = custom({
    async request({ method }) {
      requests.push(method);
      if (method === "eth_getTransactionReceipt") {
        if (opts.throwOnReceipt) throw new Error("endpoint unreachable");
        return receipt;
      }
      if (method === "eth_blockNumber") return opts.blockNumber ?? "0x1";
      if (method === "eth_chainId") return "0x8f";
      return null;
    },
  });
  return { transport, requests };
}

describe("receiptFailoverTransport", () => {
  it("takes the receipt from a LATER endpoint when the first answers null", async () => {
    // The first endpoint is healthy but has not indexed the receipt yet.
    const first = endpoint(null);
    const second = endpoint(RECEIPT);
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([first.transport, second.transport]),
    });

    const receipt = await client.getTransactionReceipt({ hash: HASH });
    expect(receipt.status).toBe("success");
    // Both were asked: the null from the first did not end the search.
    expect(first.requests).toContain("eth_getTransactionReceipt");
    expect(second.requests).toContain("eth_getTransactionReceipt");
  });

  it("still fails over when the first endpoint THROWS (the normal fallback path)", async () => {
    const first = endpoint(null, { throwOnReceipt: true });
    const second = endpoint(RECEIPT);
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([first.transport, second.transport]),
    });
    const receipt = await client.getTransactionReceipt({ hash: HASH });
    expect(receipt.status).toBe("success");
  });

  it("throws (as viem does) only when NO endpoint has the receipt", async () => {
    const first = endpoint(null);
    const second = endpoint(null);
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([first.transport, second.transport]),
    });
    // The transport returns null; viem's `getTransactionReceipt` turns that into
    // `TransactionReceiptNotFoundError`. Both endpoints were consulted first.
    await expect(client.getTransactionReceipt({ hash: HASH })).rejects.toThrow(/could not be found/i);
    expect(first.requests).toContain("eth_getTransactionReceipt");
    expect(second.requests).toContain("eth_getTransactionReceipt");
  });

  it("does not touch the other endpoints for a non-receipt method", async () => {
    const first = endpoint(null, { blockNumber: "0x2a" });
    const second = endpoint(null, { blockNumber: "0x99" });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([first.transport, second.transport]),
    });
    // `fallback` is preferred-order (rank:false): the first endpoint answers.
    await expect(client.getBlockNumber()).resolves.toBe(42n);
    expect(second.requests).not.toContain("eth_blockNumber");
  });

  it("resolves a receipt wait that the plain fallback transport would hang on", async () => {
    // Direct proof of the hang: with only the first endpoint (null) the wait
    // times out; the failover transport resolves from the second endpoint.
    const first = endpoint(null);
    const second = endpoint(RECEIPT, { blockNumber: "0x1" });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([first.transport, second.transport]),
    });
    const receipt = await client.waitForTransactionReceipt({ hash: HASH, timeout: 3000 });
    expect(receipt.status).toBe("success");
  });
});
