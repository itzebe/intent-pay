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
 * The customer checkout page.
 *
 * Drives the REAL `CheckoutClient` against a mocked `useWallet` and a mocked
 * `fetch`, so the honesty rules run for real: the page may only claim "Payment
 * complete" after the server's independent verification returns `verified`, and
 * the customer's wallet — never the page — signs the calls. This is explicitly a
 * mocked test; real-wallet/real-chain verification is separate.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const TXHASH = `0x${"a".repeat(64)}`;

const wallet: any = {
  address: SENDER,
  chainId: 143,
  provider: { request: vi.fn(async () => TXHASH) },
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
}));

// The connect control is not under test here.
vi.mock("@/components/wallet/WalletBar", () => ({
  ConnectButton: () => React.createElement("button", null, "Connect wallet"),
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
  wallet.provider.request.mockClear();
  wallet.ensureMonad.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("customer checkout page", () => {
  it("shows the amount, recipient and an open state", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [] }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
    expect(screen.getByText("Ready to pay")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pay \$25\.00/ })).toBeTruthy();
  });

  it("signs with the customer's wallet and only completes after verification", async () => {
    let verifyCalled = false;
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () =>
        verifyCalled
          ? { checkout: checkoutView({ status: "completed", phase: "payment_verified" }), txHashes: [TXHASH] }
          : { checkout: checkoutView(), txHashes: [] },
      "POST /api/checkout/chk_token/prepare": () => ({
        calls: [{ to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" }],
        quote: { payToken: "USDC", payAmount: "25", receiveToken: "USDC", receiveAmount: "25", minimumReceived: "25", slippageBps: 50, networkCostUsd: 0.01 },
      }),
      "POST /api/checkout/chk_token/submit": () => ({ intent: {}, txHashes: [TXHASH], note: "submitted" }),
      "POST /api/checkout/chk_token/verify": () => {
        verifyCalled = true;
        return { verdict: "verified", state: "verified" };
      },
    }) as any;

    render(<CheckoutClient token="chk_token" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Pay \$25\.00/ }));
    await flush();
    await flush();

    // The wallet was asked to send — the page never signs itself.
    expect(wallet.provider.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_sendTransaction" }),
    );
    // Only after verification does the page claim success.
    expect(screen.getByText(/Payment complete/)).toBeTruthy();
  });

  it("shows Confirming — never paid — while a submitted tx is unverified", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({
        checkout: checkoutView({ status: "open", phase: "transaction_submitted" }),
        txHashes: [TXHASH],
      }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    expect(screen.getByText(/confirming on-chain/i)).toBeTruthy();
    expect(screen.queryByText(/Payment complete/)).toBeNull();
  });

  it("shows an expired link as expired", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView({ status: "expired", phase: "expired" }), txHashes: [] }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    expect(screen.getByText(/expired/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pay/ })).toBeNull();
  });

  it("shows a clear error for an unknown link", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ status: 404, body: { ok: false, error: { code: "not_found", message: "No such checkout." } } }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    expect(screen.getByText(/not valid/)).toBeTruthy();
  });
});
