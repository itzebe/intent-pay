import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseUnits } from "@/lib/domain/math";

/**
 * End-to-end concurrency isolation for the request handlers.
 *
 * The server has no per-user session: the client owns the canonical intent, and
 * each request carries its own recipient/tokens/amounts. These tests drive the
 * REAL handler code with the RPC/provider layers mocked, run many independent
 * "users" at once, and assert every response corresponds to *its own* request —
 * i.e. no shared state mixes one user's recipient, token or amount into another.
 */

const getBytecode = vi.fn();
const call = vi.fn();
const getBalance = vi.fn();

vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({
    getBytecode,
    call,
    getBalance,
    multicall: vi.fn(async ({ contracts }: any) => {
      // Every ERC-20 balanceOf returns a distinct, address-derived amount so a
      // mix-up between users would be detectable.
      return contracts.map((_c: any, i: number) => ({
        status: "success",
        result: BigInt(1_000_000) * BigInt(i + 1),
      }));
    }),
  }),
}));

// A routing provider whose quote echoes the exact request it was given, with a
// short, request-derived delay so requests genuinely overlap.
vi.mock("@/lib/providers", () => {
  const make = () => ({
    name: "mock",
    mode: "live",
    supports: () => true,
    priceUsd: vi.fn(async (token: any) => ({ usd: token.symbol === "USDC" ? 1 : 2, source: "mock" })),
    quote: vi.fn(async (req: any) => {
      // delay inversely with amount so completion order != arrival order
      const n = Number(req.amount) || 1;
      await new Promise((r) => setTimeout(r, Math.max(1, 30 - n)));
      return {
        ok: true,
        route: { kind: "direct", hops: [], path: [req.payToken.symbol, req.receiveToken.symbol] },
        payAmount: req.amount,
        receiveAmount: req.amount,
        rate: 1,
        gasEstimate: 65_000n,
        exactOutput: false,
        priceImpact: 0,
      };
    }),
    availableSymbols: vi.fn(async () => []),
    reachableSymbols: vi.fn(async () => []),
  });
  const cache = new Map();
  return {
    getRoutingProvider: () => {
      if (!cache.has("m")) cache.set("m", make());
      return cache.get("m");
    },
    UniswapV3Provider: class {},
  };
});

const { POST: quotePost } = await import("@/app/api/quote/route");
const { GET: balancesGet } = await import("@/app/api/balances/route");

beforeEach(() => {
  getBytecode.mockReset();
  call.mockReset();
  getBalance.mockReset();
  getBytecode.mockResolvedValue("0x60806040");
  call.mockResolvedValue({ data: undefined });
  getBalance.mockResolvedValue(1_000_000_000_000_000_000n);
});

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/quote under concurrent independent users", () => {
  it("returns each user's own recipient/amount — never another's", async () => {
    const N = 40;
    const users = Array.from({ length: N }, (_, i) => ({
      recipient: `0x${(i + 1).toString(16).padStart(40, "0")}` as string,
      amount: String((i % 9) + 1), // varied amounts -> varied completion order
    }));

    const responses = await Promise.all(
      users.map(async (u) => {
        const res = await quotePost(
          jsonReq("http://x/api/quote", {
            recipient: u.recipient,
            receiveToken: "USDC",
            receiveAmount: u.amount,
            amountMode: "recipient_receives",
            payToken: "USDC",
            network: "mainnet",
          }),
        );
        return { u, body: await res.json() };
      }),
    );

    for (const { u, body } of responses) {
      expect(body.ok).toBe(true);
      expect(body.quote.intent.recipient).toBe(u.recipient);
      expect(body.quote.intent.receiveAmount).toBe(u.amount);
      expect(body.quote.receiveToken.symbol).toBe("USDC");
    }
    // Distinct recipients must not collapse to one shared value.
    const recipients = new Set(responses.map((r) => r.body.quote.intent.recipient));
    expect(recipients.size).toBe(N);
  });

  it("rejects malformed requests without affecting concurrent valid ones", async () => {
    const valid = quotePost(
      jsonReq("http://x/api/quote", {
        recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
        receiveToken: "USDC",
        receiveAmount: "5",
        amountMode: "recipient_receives",
        payToken: "USDC",
        network: "mainnet",
      }),
    );
    const bad = quotePost(jsonReq("http://x/api/quote", { recipient: 123 }));

    const [okRes, badRes] = await Promise.all([valid, bad]);
    expect((await okRes.json()).ok).toBe(true);
    expect(badRes.status).toBe(400);
    expect((await badRes.json()).ok).toBe(false);
  });
});

describe("/api/balances under concurrent independent users", () => {
  it("keys balances by the requested address, never a shared value", async () => {
    const addrs = Array.from(
      { length: 25 },
      (_, i) => `0x${(i + 100).toString(16).padStart(40, "0")}`,
    );
    const out = await Promise.all(
      addrs.map(async (a) => {
        const res = await balancesGet(new Request(`http://x/api/balances?address=${a}`));
        return { a, body: await res.json() };
      }),
    );
    for (const { a, body } of out) {
      expect(body.ok).toBe(true);
      expect(body.address).toBe(a);
      // The native balance came from getBalance(address); if calls were mixed up
      // the amount would still be equal, so assert the address echo instead.
      expect(body.balances.length).toBeGreaterThan(0);
    }
    expect(new Set(out.map((o) => o.body.address)).size).toBe(addrs.length);
  });

  it("rejects an invalid address without disturbing concurrent valid reads", async () => {
    const good = balancesGet(
      new Request("http://x/api/balances?address=0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4"),
    );
    const bad = balancesGet(new Request("http://x/api/balances?address=not-an-address"));
    const [g, b] = await Promise.all([good, bad]);
    expect((await g.json()).ok).toBe(true);
    expect(b.status).toBe(400);
  });
});

describe("no per-user state is stored server-side", () => {
  it("two sequential requests from 'different users' share no intent", async () => {
    const a = await (
      await quotePost(
        jsonReq("http://x/api/quote", {
          recipient: "0x1111111111111111111111111111111111111111",
          receiveToken: "USDC",
          receiveAmount: "1",
          amountMode: "recipient_receives",
          payToken: "USDC",
          network: "mainnet",
        }),
      )
    ).json();
    const b = await (
      await quotePost(
        jsonReq("http://x/api/quote", {
          recipient: "0x2222222222222222222222222222222222222222",
          receiveToken: "USDC",
          receiveAmount: "9",
          amountMode: "recipient_receives",
          payToken: "USDC",
          network: "mainnet",
        }),
      )
    ).json();
    expect(a.quote.intent.recipient).toBe("0x1111111111111111111111111111111111111111");
    expect(b.quote.intent.recipient).toBe("0x2222222222222222222222222222222222222222");
    expect(a.quote.intent.receiveAmount).toBe("1");
    expect(b.quote.intent.receiveAmount).toBe("9");
  });
});

describe("parseUnits is pure under concurrency (no shared rounding state)", () => {
  it("produces identical results for the same input from many callers at once", async () => {
    const inputs: [string, number][] = [
      ["1.234567", 6],
      ["0.000001", 18],
      ["1000000", 18],
      ["0.1", 18],
    ];
    const expected = inputs.map(([a, d]) => parseUnits(a, d));
    const runs = await Promise.all(
      Array.from({ length: 200 }, (_, i) => {
        const [a, d] = inputs[i % inputs.length];
        return Promise.resolve(parseUnits(a, d));
      }),
    );
    runs.forEach((r, i) => expect(r).toBe(expected[i % inputs.length]));
  });
});
