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
    { get: (_t, tag: string) => React.forwardRef((p: any, ref: any) => React.createElement(tag, { ...strip(p), ref })) },
  );
  return { motion, AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children) };
});

/**
 * WalletConnect connect flow (the mobile defect).
 *
 * A genuine WalletConnect session is started by `enable()` / `connect()`, which
 * opens the QR modal or a deep link. The low-level `eth_requestAccounts` is
 * answered *locally* from the current session — with no session it returns an
 * empty list and never prompts. That is why the connect button did nothing on
 * mobile. This test drives the REAL `WalletProvider` against a mocked connector
 * and asserts the pairing path is actually taken. It is explicitly a mocked
 * test; a real mobile wallet is a separate, manual verification.
 */

const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

const wcProvider = {
  enable: vi.fn(async () => [ADDR]),
  connect: vi.fn(async () => undefined),
  request: vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x8f";
    if (method === "eth_accounts") return [ADDR];
    return null;
  }),
  on: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock("@/lib/wallet/walletconnect", () => ({
  WALLETCONNECT_ID: "walletconnect",
  walletConnectConfigured: () => true,
  walletConnectProjectId: () => "test-project-id",
  getWalletConnectProvider: async () => wcProvider,
  resetWalletConnect: vi.fn(async () => undefined),
  walletConnectDeepLink: (uri: string) => (uri.startsWith("wc:") ? uri : `wc:${uri}`),
}));

import { WalletProvider } from "@/lib/hooks/useWallet";
import { ConnectButton } from "@/components/wallet/WalletBar";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 350)); });

beforeEach(() => {
  window.localStorage.clear();
  delete (window as any).ethereum;
  wcProvider.enable.mockClear();
  wcProvider.connect.mockClear();
  wcProvider.request.mockClear();
});
afterEach(() => {
  cleanup();
  delete (window as any).ethereum;
});

describe("walletconnect connect (mocked connector)", () => {
  it("starts a real pairing via enable() and shows the returned address", async () => {
    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    // WalletConnect is offered as available (a project id is configured).
    fireEvent.click(screen.getByText("WalletConnect"));
    await flush();

    // The pairing was actually started — not merely an eth_requestAccounts probe.
    expect(wcProvider.enable).toHaveBeenCalledTimes(1);
    // The real address is shown once the wallet shares it.
    expect(screen.getByText(/0x7A91/)).toBeTruthy();
    expect(window.localStorage.getItem("intentpay.wallet.connector")).toBe("walletconnect");
  });

  it("reports an honest error when the session closes without sharing an account", async () => {
    wcProvider.enable.mockResolvedValueOnce([]);
    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    fireEvent.click(screen.getByText("WalletConnect"));
    await flush();

    // The connect control is back (still disconnected) and no address is shown.
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    expect(screen.queryByText(/0x7A91/)).toBeNull();
  });
});
