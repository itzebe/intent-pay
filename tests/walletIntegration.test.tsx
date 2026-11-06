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

import { WalletProvider, useWallet } from "@/lib/hooks/useWallet";
import { ConnectButton } from "@/components/wallet/WalletBar";

/** Surfaces the shared wallet error so a test can assert the honest message. */
function ErrorProbe() {
  const w = useWallet();
  return <div data-testid="wallet-error">{w.error ?? ""}</div>;
}

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

  /**
   * Trust Wallet's in-app browser injects `window.ethereum` after the dapp has
   * booted. A previously chosen injected wallet must reconnect when it finally
   * appears — the stored choice was already made, so no user action is required.
   */
  it("restores a stored injected wallet that only appears after first paint", async () => {
    // A connector was chosen on a previous visit, but nothing is injected yet.
    window.localStorage.setItem("intentpay.wallet.connector", "legacy:metamask");

    render(
      <WalletProvider>
        <ConnectButton />
      </WalletProvider>,
    );
    await flush();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();

    // The wallet injects late (as Trust Wallet does), then discovery notices it.
    await act(async () => {
      (window as any).ethereum = makeProvider();
      await new Promise((r) => setTimeout(r, 600));
    });

    expect(screen.getByText(/0x7A91/)).toBeTruthy();
  });

  it("discovers a provider that injects AFTER the fast poll window, when the picker opens", async () => {
    // Defect A on a real device: Trust Wallet's Android in-app browser injected
    // its legacy provider around 9s — after discovery's fast poll had stopped —
    // so the picker showed "No browser wallet detected". Opening the picker must
    // re-scan, so the wallet is offered at the moment the user asks to connect.
    vi.useFakeTimers();
    try {
      render(
        <WalletProvider>
          <ConnectButton />
        </WalletProvider>,
      );
      // Past the fast window, still nothing injected.
      await act(async () => {
        vi.advanceTimersByTime(7000);
      });

      // The wallet finally injects (Trust Wallet style: window.trustwallet only).
      (window as any).trustwallet = { ethereum: makeProvider({ isTrust: true }) };

      // The user opens the picker; the re-scan must find it.
      fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
      await act(async () => {
        vi.advanceTimersByTime(50);
      });

      expect(screen.getByText("Trust Wallet")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect a deliberately disconnected wallet when a late provider appears", async () => {
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

    // The user disconnects on purpose — the stored choice is cleared.
    fireEvent.click(screen.getByRole("button", { name: /wallet menu/i }));
    fireEvent.click(screen.getByText("Disconnect"));
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();

    // A later discovery event must not silently reconnect it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
  });

  /**
   * Defect A. A page-world injected wallet answers `eth_chainId` by proxying to
   * its own node; when that read is blocked or the node is unreachable the call
   * throws a bare `TypeError: Failed to fetch` (no EIP-1193 code). The wallet is
   * still authorised, so the connection must complete — the chain is simply
   * reported as unknown rather than failing the whole connect, and no
   * WalletConnect is involved.
   */
  it("connects an injected wallet directly even when its chain read fails", async () => {
    const ADDR2 = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
    const provider = {
      isMetaMask: true,
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [ADDR2];
        // Simulate the CSP-blocked / unreachable wallet RPC.
        if (method === "eth_chainId") throw new TypeError("Failed to fetch");
        return null;
      }),
      on: () => {},
      removeListener: () => {},
    };
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

    // Connected directly: the real address is shown...
    expect(screen.getByText(/0x7A91/)).toBeTruthy();
    // ...and the blocked chain read is NOT misreported as a failed connection.
    expect(screen.queryByText(/Couldn't connect to the wallet/i)).toBeNull();
    expect(provider.request).toHaveBeenCalledWith({ method: "eth_requestAccounts" });
  });

  it("surfaces an honest message and stays disconnected when the wallet shares no account", async () => {
    const provider = {
      isMetaMask: true,
      request: vi.fn(async ({ method }: { method: string }) => {
        // The wallet is present but the user approved nothing.
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [];
        if (method === "eth_chainId") return "0x8f";
        return null;
      }),
      on: () => {},
      removeListener: () => {},
    };
    (window as any).ethereum = provider;

    render(
      <WalletProvider>
        <ConnectButton />
        <ErrorProbe />
      </WalletProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    fireEvent.click(screen.getByText("MetaMask"));
    await flush();

    // Not a phantom connection: still the connect control, with the real reason.
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    expect(screen.getByTestId("wallet-error").textContent).toMatch(/didn't share an account/i);
    // A failed injected attempt must not leave a WalletConnect session behind.
    expect(window.localStorage.getItem("intentpay.wallet.connector")).not.toBe("walletconnect");
  });

  it("does not silently fall back to WalletConnect when an injected connect fails", async () => {
    // WalletConnect is unconfigured, so a silent substitution is impossible —
    // and the injected failure must still surface as its own error.
    const provider = {
      isMetaMask: true,
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [];
        if (method === "eth_chainId") return "0x8f";
        return null;
      }),
      on: () => {},
      removeListener: () => {},
    };
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

    // Still disconnected, WalletConnect still honestly "Off" (no project id).
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));
    await flush();
    expect(screen.getByText("WalletConnect")).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
  });
});
