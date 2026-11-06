// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// framer-motion's exit animations keep React's act() pending; render plain
// elements instead. The resilience rules under test are independent of animation.
vi.mock("framer-motion", () => {
  const strip = (props: Record<string, any>) => {
    const { initial, animate, exit, transition, variants, whileHover, whileTap, layout, ...rest } = props;
    return rest;
  };
  const motion = new Proxy(
    {},
    { get: (_t, tag: string) => React.forwardRef((p: any, ref: any) => React.createElement(tag, { ...strip(p), ref })) },
  );
  return { motion, AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children) };
});

import { CheckoutClient } from "@/components/checkout/CheckoutClient";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Checkout resilience — the "blank screen after Continue Payment" regression.
 *
 * The customer page must never unmount the tree. Two distinct ways it used to:
 *   - an unrecognised `phase` from the server indexed a `Record` and read
 *     `.tone` off `undefined` (a newer server than the loaded bundle);
 *   - a malformed `prepare` response was dereferenced without a guard.
 * A thrown render error is caught by the ErrorBoundary, but a *blank* checkout
 * is not an acceptable outcome either: the page must render a usable state.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const TXHASH = `0x${"a".repeat(64)}`;

const wallet: any = {
  address: SENDER,
  chainId: 143,
  kind: "injected",
  network: "mainnet",
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
  useBalances: () => ({ balances: [], loading: false, error: undefined, refresh: vi.fn(), setBalances: vi.fn() }),
}));
vi.mock("@/components/wallet/WalletBar", () => ({
  ConnectButton: () => React.createElement("button", null, "Connect wallet"),
  BalanceOverview: () => React.createElement("div", null, "Your wallet"),
}));
vi.mock("@/lib/wallet/clients", () => ({
  getClientPublicClient: () => ({ waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const })) }),
}));

function checkoutView(overrides: Record<string, unknown> = {}) {
  return {
    id: "chk_1",
    object: "checkout",
    status: "open",
    phase: "awaiting_payment",
    orderReference: "ORDER-1001",
    chainId: 143,
    recipient: SENDER,
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

beforeEach(() => { wallet.provider.request.mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("checkout resilience", () => {
  it("renders a usable page (not blank) for an unrecognised phase", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView({ phase: "brand_new_phase" }), txHashes: [] }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    // The page is still there and shows the amount — no crash, no blank tree.
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
    expect(screen.getByText(/Updating your payment status/i)).toBeTruthy();
    // An unknown phase is never reported as a completed payment.
    expect(screen.queryByText(/Payment complete/)).toBeNull();
  });

  it("survives a null phase without crashing", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView({ phase: null }), txHashes: [] }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
  });

  it("does not trip the ErrorBoundary for an unknown phase", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView({ phase: "future_phase" }), txHashes: [] }),
    }) as any;
    render(
      <ErrorBoundary scope="app">
        <CheckoutClient token="chk_token" />
      </ErrorBoundary>,
    );
    await flush();
    expect(screen.queryByText(/Unable to prepare this payment/)).toBeNull();
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
  });

  it("shows a clear error (not a crash) for a malformed prepare response", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [] }),
      "POST /api/checkout/chk_token/prepare": () => ({ quote: {} }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Pay \$25\.00/ }));
    await flush();
    await flush();
    expect(screen.getByText(/could not be prepared/i)).toBeTruthy();
    // The page is still interactive — the customer can retry.
    expect(screen.getByRole("button", { name: /Pay \$25\.00/ })).toBeTruthy();
  });

  it("shows a specific message (not a crash) when the wallet rejects", async () => {
    const rejection = Object.assign(new Error("User rejected the request"), { code: 4001 });
    wallet.provider.request.mockRejectedValueOnce(rejection);
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [] }),
      "POST /api/checkout/chk_token/prepare": () => ({
        calls: [{ to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" }],
        quote: { payToken: "USDC", payAmount: "25", receiveToken: "USDC", receiveAmount: "25", minimumReceived: "25", slippageBps: 50, networkCostUsd: 0.01 },
      }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Pay \$25\.00/ }));
    await flush();
    await flush();
    expect(screen.getByText(/declined the transaction in your wallet/i)).toBeTruthy();
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
  });

  /**
   * The reported "Continue Payment" symptom: after preparing, the customer's
   * wallet provider throws while broadcasting (its own RPC unreachable — a CSP
   * block or a dead node). That must be a specific, non-blank, *wallet*-side
   * message, never a generic failure and never a claim that Intent Pay's own
   * network is down. Nothing was submitted, so the page must stay usable.
   */
  it("shows a wallet-side network message (not blank) when the wallet provider fails to broadcast", async () => {
    wallet.provider.request.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [] }),
      "POST /api/checkout/chk_token/prepare": () => ({
        calls: [{ to: "0x0000000000000000000000000000000000000001", data: "0x", value: "0" }],
        quote: { payToken: "USDC", payAmount: "25", receiveToken: "USDC", receiveAmount: "25", minimumReceived: "25", slippageBps: 50, networkCostUsd: 0.01 },
      }),
    }) as any;
    render(
      <ErrorBoundary scope="app">
        <CheckoutClient token="chk_token" />
      </ErrorBoundary>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Pay \$25\.00/ }));
    await flush();
    await flush();
    expect(screen.getByText(/wallet couldn't complete its network request/i)).toBeTruthy();
    // Our own reads are explicitly not the problem, and nothing was submitted.
    expect(screen.getByText(/Intent Pay's own chain reads are unaffected/i)).toBeTruthy();
    expect(screen.queryByText(/network provider is temporarily unavailable/i)).toBeNull();
    // The page is still usable: the customer can retry, not a blank screen.
    expect(screen.getByRole("button", { name: /Pay \$25\.00/ })).toBeTruthy();
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
  });
});

/**
 * The render path reads `receiveToken`, `recipient` and `amount` directly, so a
 * malformed checkout from a newer/older server used to throw inside render
 * (`receiveToken.slice`) and blank the page. Every such payload must now render
 * the honest "unavailable" state instead — never an unmounted tree.
 */
describe("checkout payload validation", () => {
  const cases: Array<[string, unknown]> = [
    ["a missing receiveToken", checkoutView({ receiveToken: undefined })],
    ["a null receiveToken", checkoutView({ receiveToken: null })],
    ["an empty receiveToken", checkoutView({ receiveToken: "" })],
    ["a missing recipient", checkoutView({ recipient: undefined })],
    ["a missing amount", checkoutView({ amount: undefined })],
    ["a non-numeric amount", checkoutView({ amount: "abc" })],
    ["a non-object checkout", "not-an-object"],
    ["an array checkout", []],
    ["a null checkout", null],
  ];

  for (const [name, checkout] of cases) {
    it(`renders a usable page (not blank) for ${name}`, async () => {
      global.fetch = mockFetch({
        "GET /api/checkout/chk_token": () => ({ checkout, txHashes: [] }),
      }) as any;
      render(
        <ErrorBoundary scope="app">
          <CheckoutClient token="chk_token" />
        </ErrorBoundary>,
      );
      await flush();
      // No crash / no blank: the honest unavailability message is shown and the
      // ErrorBoundary fallback was not tripped.
      expect(screen.getByText(/could not be read|not valid|unavailable/i)).toBeTruthy();
      expect(screen.queryByText(/Unable to prepare this payment/)).toBeNull();
    });
  }

  it("ignores non-string transaction hashes rather than rendering them", async () => {
    global.fetch = mockFetch({
      "GET /api/checkout/chk_token": () => ({ checkout: checkoutView(), txHashes: [123, null, "0xabc"] }),
    }) as any;
    render(<CheckoutClient token="chk_token" />);
    await flush();
    expect(screen.getByText("$25.00 in USDC")).toBeTruthy();
    // The numeric/null entries are dropped; only the real hash is linked.
    expect(screen.getAllByRole("link").some((a) => a.getAttribute("href")?.includes("0xabc"))).toBe(true);
  });
});
