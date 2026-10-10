import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Cold-start fan-out.
 *
 * The routing provider's pool graph and its price cache have no in-flight
 * de-duplication: a burst of concurrent *cold* quotes (a fresh serverless
 * instance, or a graph/price entry that just expired) each rebuild the graph /
 * recompute the price independently, multiplying external RPC calls by the
 * concurrency. This measures that fan-out directly by counting RPC calls.
 */

const readContract = vi.fn();
const getBytecode = vi.fn();

vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({
    readContract,
    getBytecode,
    call: vi.fn(async () => ({ data: undefined })),
    multicall: vi.fn(async () => []),
  }),
}));

const { UniswapV3Provider } = await import("@/lib/providers/uniswapV3");
const { getToken } = await import("@/lib/config/tokens");

beforeEach(() => {
  readContract.mockReset();
  getBytecode.mockReset();
  getBytecode.mockResolvedValue("0x60806040");
  // Empty aggregate3 result => "no pools"; we only count the calls here. A real
  // RPC round-trip takes time, so the mock waits a tick — that is the window in
  // which concurrent callers must coalesce onto one build.
  readContract.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 25));
    return [] as any;
  });
  global.fetch = vi.fn(async () => {
    throw new Error("no network in test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cold quote fan-out (concurrency x external RPC calls)", () => {
  const oneCold = (p: InstanceType<typeof UniswapV3Provider>) =>
    p.quote({
      payToken: getToken("USDC")!,
      receiveToken: getToken("USDT")!,
      mode: "recipient_receives",
      amount: "5",
      usd: true,
      network: "mainnet",
    });

  async function buildsFor(concurrency: number): Promise<number> {
    const p = new UniswapV3Provider("mainnet");
    readContract.mockClear();
    await Promise.all(Array.from({ length: concurrency }, () => oneCold(p)));
    return readContract.mock.calls.length;
  }

  it("RPC fan-out does not scale with concurrency on a cold instance", async () => {
    // A fresh serverless instance receiving a burst: every caller needs the same
    // graph, so the number of upstream reads must be a small constant — not one
    // build per concurrent user.
    const few = await buildsFor(2);
    const many = await buildsFor(50);
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(3); // price anchor probes + the main graph
    expect(many).toBeLessThan(50);
  });
});
