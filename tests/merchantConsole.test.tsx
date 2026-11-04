// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

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

import { MerchantConsole } from "@/components/merchant/MerchantConsole";

/**
 * The merchant console.
 *
 * Drives the REAL `MerchantConsole` against a mocked `fetch`, asserting the two
 * honesty rules of the console: it is gated on a valid API key, and it creates
 * the intent then the checkout (never a second stack). The QR renderer is
 * stubbed — it is a presentation detail, not the contract under test.
 */

const wallet: any = {
  address: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
  chainId: 143,
  provider: null,
  ensureMonad: vi.fn(),
  wallets: [],
  connect: vi.fn(),
  disconnect: vi.fn(),
  status: "connected",
  hasProvider: true,
  restoring: false,
};

vi.mock("@/lib/hooks/useWallet", () => ({ useWallet: () => wallet }));
vi.mock("@/components/checkout/PaymentQR", () => ({ PaymentQR: () => React.createElement("div", null, "QR") }));

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("merchant console", () => {
  it("gates on a valid API key and surfaces a rejected one", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "bad key" } }), { status: 401 })) as any;
    render(<MerchantConsole />);
    const input = screen.getByPlaceholderText("ipk_live_…");
    fireEvent.change(input, { target: { value: "ipk_live_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await flush();
    expect(screen.getByText(/not accepted/)).toBeTruthy();
  });

  it("creates an intent then a checkout and shows the payment link", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/developers") {
        return new Response(JSON.stringify({ ok: true, developer: { id: "dev_1", name: "shop", status: "active" }, keys: [] }), { status: 200 });
      }
      if (url === "/api/v1/checkouts" && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ ok: true, checkouts: [] }), { status: 200 });
      }
      if (url === "/api/v1/intents") {
        return new Response(JSON.stringify({ ok: true, created: true, intent: { id: "int_1" } }), { status: 201 });
      }
      if (url === "/api/v1/checkouts" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, created: true, token: `chk_${"a".repeat(64)}`, checkout: { id: "chk_1", token: `chk_${"a".repeat(64)}`, status: "open", phase: "awaiting_payment", orderReference: "ORDER-1", expiresAt: "2099-01-01T00:30:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    render(<MerchantConsole />);
    fireEvent.change(screen.getByPlaceholderText("ipk_live_…"), { target: { value: "ipk_live_ok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await flush();

    // The console is now usable; create a link.
    fireEvent.click(screen.getByRole("button", { name: /Create payment link/ }));
    await flush();

    // The intent was created before the checkout — one stack, in order.
    const intentIdx = calls.indexOf("POST /api/v1/intents");
    const checkoutIdx = calls.indexOf("POST /api/v1/checkouts");
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeGreaterThan(intentIdx);
    expect(screen.getByText(/\/checkout\/chk_/)).toBeTruthy();
  });
});
