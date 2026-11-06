import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicClient, custom, defineChain, http } from "viem";
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

describe("receiptFailoverTransport survives a stalled endpoint", () => {
  /**
   * A transport that throws every request — the shape a *stalled* endpoint takes
   * once its own timeout fires. (A transport that never settles cannot be used
   * with `createPublicClient` in a test, because the client's request pipeline
   * has no external deadline; the real deadline is the endpoint's `timeout`,
   * which the client builders set to `ENDPOINT_TIMEOUT_MS`.)
   */
  const failing = () =>
    custom({
      request: async () => {
        throw new Error("stalled");
      },
    });

  it("answers from a later endpoint when the preferred one has stalled", async () => {
    const fast = endpoint(null, { blockNumber: "0x2a" });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([failing(), fast.transport]),
    });
    await expect(client.getBlockNumber()).resolves.toBe(42n);
    expect(fast.requests).toContain("eth_blockNumber");
  });

  it("does not retry a failed endpoint on the next read (circuit breaker)", async () => {
    let brokenCalls = 0;
    const broken = custom({
      request: async () => {
        brokenCalls += 1;
        throw new Error("stalled");
      },
    });
    const fast = endpoint(null, { blockNumber: "0x2a" });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([broken, fast.transport], { cooldownMs: 60_000 }),
    });
    // `client.request` bypasses viem's block-number cache so each read really
    // reaches the transport.
    const read = () => client.request({ method: "eth_blockNumber" });
    await expect(read()).resolves.toBe("0x2a");
    await expect(read()).resolves.toBe("0x2a");
    await expect(read()).resolves.toBe("0x2a");
    // The failed endpoint was tried once; the cooldown sent every later read
    // straight to the healthy endpoint.
    expect(brokenCalls).toBe(1);
    expect(fast.requests.filter((m) => m === "eth_blockNumber")).toHaveLength(3);
  });

  it("tries a cooling-down endpoint again when it is the only one left", async () => {
    let calls = 0;
    const flaky = custom({
      request: async ({ method }) => {
        if (method !== "eth_blockNumber") return null;
        calls += 1;
        if (calls === 1) throw new Error("blip");
        return "0x2a";
      },
    });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([flaky], { cooldownMs: 60_000 }),
    });
    const read = () => client.request({ method: "eth_blockNumber" });
    // The first read fails — with one endpoint there is nowhere to fail over to.
    await expect(read()).rejects.toThrow();
    // But that endpoint is still the only way to answer, so the breaker must not
    // lock the client out of it.
    await expect(read()).resolves.toBe("0x2a");
    expect(calls).toBe(2);
  });

  it("rejects only after every endpoint has failed", async () => {
    const broken = custom({
      request: async () => {
        throw new Error("boom");
      },
    });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([broken, broken]),
    });
    await expect(client.getBlockNumber()).rejects.toThrow(/boom/);
  });

  it("keeps preferring the first endpoint while it is healthy", async () => {
    const first = endpoint(null, { blockNumber: "0x2a" });
    const second = endpoint(null, { blockNumber: "0x99" });
    const client = createPublicClient({
      chain,
      transport: receiptFailoverTransport([first.transport, second.transport]),
    });
    await expect(client.getBlockNumber()).resolves.toBe(42n);
    // The healthy preferred endpoint answered, so the fallback was never used.
    expect(second.requests).not.toContain("eth_blockNumber");
  });
});

describe("a stalled endpoint is tried exactly once per read", () => {
  /**
   * The endpoint builders must NOT set their own `retryCount`.
   *
   * viem's `http` resolves its retry count as `config.retryCount ?? transport
   * retryCount`, so a `retryCount` passed to `http(...)` overrides the
   * transport's `retryCount: 0`. With `retryCount: 1` a stalled preferred
   * endpoint was hit twice per read (each attempt paying `ENDPOINT_TIMEOUT_MS`),
   * which is the whole cost the failover exists to avoid. The transport owns the
   * failover, so the endpoint must defer to it. This test uses REAL HTTP servers
   * so the count is the number of sockets the endpoint actually received.
   */
  it("hits the stalled endpoint once and answers from the next within one timeout", async () => {
    let stallHits = 0;
    const stall = createServer(() => {
      // Accept the connection and never reply.
      stallHits += 1;
    });
    const good = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }));
    });
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => good.listen(0, "127.0.0.1", resolve));
    const stallUrl = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
    const goodUrl = `http://127.0.0.1:${(good.address() as AddressInfo).port}`;

    try {
      // Mirror the production client builders (a short per-endpoint timeout, no
      // endpoint-level retryCount — the transport owns failover), but with a
      // smaller timeout so the test is quick; the retry semantics do not depend
      // on the timeout value.
      const endpointTimeout = 800;
      const client = createPublicClient({
        chain,
        transport: receiptFailoverTransport([
          http(stallUrl, { timeout: endpointTimeout }),
          http(goodUrl, { timeout: endpointTimeout }),
        ]),
      });
      const started = Date.now();
      const block = await client.request({ method: "eth_blockNumber" });
      const elapsed = Date.now() - started;

      expect(block).toBe("0x2a");
      // One attempt on the stalled endpoint, not `1 + retryCount`.
      expect(stallHits).toBe(1);
      // And the whole read cost a single endpoint timeout, not two.
      expect(elapsed).toBeLessThan(endpointTimeout * 2);
    } finally {
      stall.close();
      good.close();
    }
  }, 20_000);
});
