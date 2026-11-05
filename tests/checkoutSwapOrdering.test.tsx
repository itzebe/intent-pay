// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// framer-motion's exit animations keep React's act() pending; render plain
// elements instead. The flow logic under test is independent of the animation.
vi.mock("framer-motion", () => {
  const strip = (props: Record<string, any>) => {
    const { initial, animate, exit, transition, variants, whileHover, whileTap, layout, ...rest } = props;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef((props: any, ref: any) =>
          React.createElement(tag, { ...strip(props), ref }),
        ),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children),
  };
});

import { CheckoutClient } from "@/components/checkout/CheckoutClient";

/**
 * Checkout swap-step ordering.
 *
 * A swap payment is several sequential transactions (approve → swap → unwrap →
 * deliver). Each depends on the previous one being *mined*: the swap needs the
 * approval to have landed. The customer page must therefore wait for each
 * receipt before broadcasting the next call — the regression was broadcasting
 * them back-to-back, so the swap executed before its approval and reverted.
 *
 * This is explicitly a mocked test: it proves the *ordering rule*, not a real
 * wallet. Real-wallet/real-chain verification is separate.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

/** The ordered log of sends and receipt-waits the page performs. */
const events: string[] = [];
const waitForTransactionReceipt = vi.fn();

vi.mock("@/lib/wallet/clients", () => ({
  getClientPublicClient: () => ({ waitForTransactionReceipt }),
}));

const wallet: any = {
  address: SENDER,
  chainId: 143,
  network: "mainnet",
  provider: { request: vi.fn() },
  ensureMonad: vi.fn(async () => ({ ok: true })),
  wallets: [],
  connect: vi.fn(),
  disconnect: vi.fn(),
  status: "connected",
  hasProvider: true,
  restoring: false,
};

vi.mock("@/lib/hooks/useWallet", () => ({
  useWallet: () => wallet,
  useBalances: () => ({ balances: [], loading: false, error: undefined, refresh: vi.fn(), setBalances: vi.fn() }),
}));

vi.mock("@/components/wallet/WalletBar", () => ({
  ConnectButton: () => React.createElement("button", null, "Connect wallet"),
  BalanceOverview: () => React.createElement("div", null, "Your wallet"),
}));

function checkoutView(overrides: Record<string, unknown> = {}) {
  return {
    id: "chk_1",
    object: "checkout",
    status: "open",
    phase: "awaiting_payment",
    orderReference: "ORDER-1001",
    chainId: 143,
    recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    receiveToken: "USDC",
    receiveTokenAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aaf603",
    amountMode: "recipient_receives",
    amount: "25",
    payToken: null,
    expiresAt: "2099-01-01T00:30:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockFetch(handlers: Record<string, () => unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    const result = handler();
    const status = (result as { status?: number })?.status ?? 200;
    const body = (result as { body?: unknown })?.body ?? result;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  events.length = 0;
  waitForTransactionReceipt.mockReset();
  waitForTransactionReceipt.mockImplementation(async (args: { hash: string }) => {
    events.push(`wait:${args.hash.slice(2, 6)}`);
    return { status: "success" as const };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("checkout swap-step ordering", () => {
  it("waits for each transaction's receipt before broadcasting the next", async () => {
    const sent: string[] = [HASH_A, HASH_B];
    let n = 0;
    wallet.provider.request = vi.fn(async (args: any) => {
      if (args.method === "eth_sendTransaction") {
        const hash = sent[n++];
        events.push(`send:${hash.slice(2, 6)}`);
        return hash;
      }
      return undefined;
    });

    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [] }),
      // A swap plan: approve then swap — two calls.
      "POST /api/checkout/chk_token/prepare": () => ({
        calls: [
          { to: "0x0000000000000000000000000000000000000001", data: "0x1234", value: "0" },
          { to: "0x0000000000000000000000000000000000000002", data: "0x5678", value: "0" },
        ],
        quote: { payToken: "MON", payAmount: "56", receiveToken: "USDC", receiveAmount: "25", minimumReceived: "25", slippageBps: 50, networkCostUsd: 0.01 },
      }),
      "POST /api/checkout/chk_token/submit": () => ({ txHashes: sent }),
      "POST /api/checkout/chk_token/verify": () => ({ verdict: "pending", retryable: true }),
    }) as any;

    render(<CheckoutClient token="chk_token" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Pay \$25\.00/ }));
    await flush();
    await flush();

    // Strict interleaving: send → wait → send → wait. Never send → send.
    expect(events).toEqual(["send:aaaa", "wait:aaaa", "send:bbbb", "wait:bbbb"]);
  });

  it("does not broadcast the dependent step when the first transaction reverts", async () => {
    waitForTransactionReceipt.mockImplementation(async (args: { hash: string }) => {
      events.push(`wait:${args.hash.slice(2, 6)}`);
      return { status: "reverted" as any };
    });
    const sent: string[] = [HASH_A, HASH_B];
    let n = 0;
    wallet.provider.request = vi.fn(async (args: any) => {
      if (args.method === "eth_sendTransaction") {
        const hash = sent[n++];
        events.push(`send:${hash.slice(2, 6)}`);
        return hash;
      }
      return undefined;
    });

    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [] }),
      "POST /api/checkout/chk_token/prepare": () => ({
        calls: [
          { to: "0x0000000000000000000000000000000000000001", data: "0x1234", value: "0" },
          { to: "0x0000000000000000000000000000000000000002", data: "0x5678", value: "0" },
        ],
        quote: { payToken: "MON", payAmount: "56", receiveToken: "USDC", receiveAmount: "25", minimumReceived: "25", slippageBps: 50, networkCostUsd: 0.01 },
      }),
      "POST /api/checkout/chk_token/submit": () => ({ txHashes: [HASH_A] }),
    }) as any;

    render(<CheckoutClient token="chk_token" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Pay \$25\.00/ }));
    await flush();
    await flush();

    // The second call is never sent once the first reverted.
    expect(events).toEqual(["send:aaaa", "wait:aaaa"]);
    expect(screen.getByText(/reverted on Monad/)).toBeTruthy();
  });
});
