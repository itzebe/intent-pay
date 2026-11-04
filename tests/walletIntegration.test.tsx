// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// framer-motion's exit animations keep React's act() pending; render plain
// elements instead. The wallet logic under test is independent of animation.
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

import { WalletProvider } from "@/lib/hooks/useWallet";
import { ConnectButton } from "@/components/wallet/WalletBar";

/**
 * Integration test for the shared wallet connection + connect UX.
 *
 * This drives the REAL `WalletProvider` and `ConnectButton` against a MOCKED
 * EIP-1193 provider (a synthetic `window.ethereum`), covering the adapter
 * contract: discovery → connect → address shown → account change → disconnect.
 * It is explicitly a mocked test; real-wallet verification is separate.
 */

const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

type Handler = (...args: any[]) => void;

function makeProvider(overrides: Partial<Record<string, unknown>> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  return {
    isMetaMask: true,
    request: vi.fn(async ({ method }: { method: string }) => {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [ADDR];
        case "eth_chainId":
          return "0x8f";
        default:
          return (overrides[method] as unknown) ?? null;
      }
    }),
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    removeListener(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    _emit(event: string, ...args: any[]) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 300)); });

beforeEach(() => {
  window.localStorage.clear();
  delete (window as any).ethereum;
});

afterEach(() => {
  cleanup();
  delete (window as any).ethereum;
});

describe("wallet connection (mocked injected provider)", () => {
  it("lists a discovered injected wallet and connects it, showing the real address", async () => {
    const provider = makeProvider();
    (window as any).ethereum = provider;

    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();

    // The connect control is offered.
    const connectBtn = screen.getByRole("button", { name: /connect wallet/i });
    fireEvent.click(connectBtn);

    // The picker lists the detected wallet by name (EIP-6963-friendly label).
    expect(screen.getByText("MetaMask")).toBeTruthy();

    fireEvent.click(screen.getByText("MetaMask"));
    await flush();

    // eth_requestAccounts was actually called, and the real address is shown.
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
    expect(screen.getByText(/0x7A91/)).toBeTruthy();
  });

  it("reflects an account change and a disconnect event from the wallet", async () => {
    const provider = makeProvider();
    (window as any).ethereum = provider;

    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    fireEvent.click(screen.getByText("MetaMask"));
    await flush();
    expect(screen.getByText(/0x7A91/)).toBeTruthy();

    // The wallet switches account.
    const other = "0x1111111111111111111111111111111111111111";
    await act(async () => {
      provider._emit("accountsChanged", [other]);
    });
    expect(screen.getByText(/0x1111/)).toBeTruthy();

    // The wallet drops the connection (empty account list).
    await act(async () => {
      provider._emit("accountsChanged", []);
    });
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
  });

  it("disconnects safely via the menu and clears the stored choice", async () => {
    const provider = makeProvider();
    (window as any).ethereum = provider;

    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    fireEvent.click(screen.getByText("MetaMask"));
    await flush();

    expect(window.localStorage.getItem("intentpay.wallet.connector")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /wallet menu/i }));
    fireEvent.click(screen.getByText("Disconnect"));

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    expect(window.localStorage.getItem("intentpay.wallet.connector")).toBeNull();
  });

  it("reports honestly when no injected wallet exists and WalletConnect is unconfigured", async () => {
    delete (window as any).ethereum;

    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    // WalletConnect is shown but unavailable (no project id configured).
    expect(screen.getByText("WalletConnect")).toBeTruthy();
    expect(screen.getByText(/No browser wallet detected/i)).toBeTruthy();
  });
});
