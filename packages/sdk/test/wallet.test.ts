import { afterEach, describe, expect, it, vi } from "vitest";
import { Wallet, discoverWallets, watchWallets } from "../src/wallet/index.js";
import { collectLegacyWallets, LEGACY_SLOW_POLL_MS } from "../src/wallet/eip6963.js";
import { WalletError } from "../src/core/errors.js";
import {
  chainIdFromHex,
  firstAccount,
  isMonadChainId,
  isUserRejection,
  walletErrorMessage,
  MONAD_CHAIN_ID,
} from "../src/wallet/provider.js";
import { installLegacyWindow, installWindow, makeProvider, type FakeProvider } from "./fakeWallet.js";

const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("discovery (EIP-6963 + legacy)", () => {
  it("discovers a single legacy injected wallet", async () => {
    cleanup = installLegacyWindow(makeProvider());
    const wallets = await discoverWallets();
    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.announced).toBe(false);
  });

  it("discovers several announced wallets", async () => {
    const metamask = makeProvider();
    const rabby = makeProvider();
    cleanup = installWindow({
      providers: [
        { info: { uuid: "u1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: metamask },
        { info: { uuid: "u2", name: "Rabby", icon: "", rdns: "io.rabby" }, provider: rabby },
      ],
    });
    const wallets = await discoverWallets();
    expect(wallets.map((w) => w.name).sort()).toEqual(["MetaMask", "Rabby"]);
    expect(wallets.every((w) => w.announced)).toBe(true);
  });

  it("labels a known rdns with its friendly name", async () => {
    cleanup = installWindow({
      providers: [{ info: { uuid: "u1", name: "MetaMask Extension", icon: "", rdns: "io.metamask" }, provider: makeProvider() }],
    });
    const wallets = await discoverWallets();
    expect(wallets[0]!.name).toBe("MetaMask");
  });

  it("expands a legacy providers array into selectable wallets", async () => {
    const legacy = makeProvider({ isMetaMask: true });
    (legacy as { providers?: unknown[] }).providers = [makeProvider({ isMetaMask: true }), makeProvider({ isCoinbaseWallet: true })];
    cleanup = installLegacyWindow(legacy);
    const wallets = await discoverWallets();
    expect(wallets.map((w) => w.name)).toEqual(["MetaMask", "Coinbase Wallet"]);
  });

  it("discovers a Trust Wallet provider exposed only on window.trustwallet.ethereum", () => {
    const trust = makeProvider({ isTrust: true });
    cleanup = installWindow({});
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ...(globalThis as unknown as { window: Record<string, unknown> }).window,
      trustwallet: { ethereum: trust },
    };
    const wallets = collectLegacyWallets((globalThis as unknown as { window: Window }).window);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.name).toBe("Trust Wallet");
    expect(wallets[0]!.id).toBe("legacy:trust");
  });

  it("resolves a FACTORY-shaped window.trustwallet.ethereum (the shipped provider bundle)", () => {
    // The shipped bundle exposes `window.trustwallet.ethereum` as a factory
    // function (`ethereum: (config) => new EthereumProvider(config)`), not the
    // provider. A bare `request`-property check missed a namespace-only
    // injection; the factory is called (no config) and its provider is used.
    const trust = makeProvider({ isTrust: true });
    const factory = vi.fn(() => trust);
    cleanup = installWindow({});
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ...(globalThis as unknown as { window: Record<string, unknown> }).window,
      trustwallet: { ethereum: factory },
    };
    const wallets = collectLegacyWallets((globalThis as unknown as { window: Window }).window);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(wallets).toHaveLength(1);
    expect(wallets[0]!.name).toBe("Trust Wallet");
    expect(wallets[0]!.id).toBe("legacy:trust");
    expect(wallets[0]!.provider).toBe(trust);
  });

  it("ignores a factory that throws or returns a non-provider", () => {
    cleanup = installWindow({});
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
    win.trustwallet = { ethereum: () => { throw new Error("no config"); } };
    expect(collectLegacyWallets(win as unknown as Window)).toEqual([]);
    win.trustwallet = { ethereum: () => ({ notRequest: true }) };
    expect(collectLegacyWallets(win as unknown as Window)).toEqual([]);
  });

  it("discovers a FACTORY-only namespace injected late (no window.ethereum at all)", () => {
    vi.useFakeTimers();
    try {
      const trust = makeProvider({ isTrust: true });
      cleanup = installWindow({});
      const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
      const seen: number[] = [];
      const watcher = watchWallets(win as unknown as Window, (w) => seen.push(w.length));
      expect(seen[seen.length - 1]).toBe(0);
      // Factory namespace only; `window.ethereum` is never set. Only the poll can
      // find it (no `ethereum#initialized` is dispatched).
      win.trustwallet = { ethereum: () => trust };
      vi.advanceTimersByTime(LEGACY_SLOW_POLL_MS * 2);
      expect(seen[seen.length - 1]).toBe(1);
      watcher.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a legacy provider a stable id derived from its identity, not its index", () => {
    const mm = makeProvider({ isMetaMask: true });
    const trust = makeProvider({ isTrust: true });
    const a = collectLegacyWallets({
      ethereum: { ...makeProvider(), providers: [mm, trust] },
    } as unknown as Window);
    const b = collectLegacyWallets({
      ethereum: { ...makeProvider(), providers: [trust, mm] },
    } as unknown as Window);
    expect(a.map((w) => w.id).sort()).toEqual(b.map((w) => w.id).sort());
    expect(a.map((w) => w.id)).toContain("legacy:trust");
  });

  it("discovers a legacy-only provider that appears AFTER watchWallets starts", () => {
    const trust = makeProvider({ isTrust: true });
    cleanup = installWindow({});
    const win = (globalThis as unknown as { window: { lateInject: (p: FakeProvider, onWindow?: boolean) => void } }).window;
    const seen: number[] = [];
    const watcher = watchWallets((globalThis as unknown as { window: Window }).window, (w) => seen.push(w.length));
    expect(seen[seen.length - 1]).toBe(0);
    win.lateInject(trust);
    expect(seen[seen.length - 1]).toBe(1);
    watcher.destroy();
  });

  it("does not list a wallet twice when the same provider both announces and is on window.ethereum", async () => {
    // The production defect: a wallet present on `window.ethereum` before the app
    // boots is read from the legacy slot, then answers `eip6963:requestProvider`
    // with the SAME provider object — which used to produce two picker rows.
    const provider = makeProvider({ isMetaMask: true });
    cleanup = installWindow({
      legacy: provider,
      providers: [{ info: { uuid: "u-mm", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider }],
    });
    const wallets = await discoverWallets();
    expect(wallets).toHaveLength(1);
  });

  it("discovers a Trust Wallet provider that injects late on window.trustwallet only", () => {
    const trust = makeProvider({ isTrust: true });
    cleanup = installWindow({});
    const win = (globalThis as unknown as { window: { lateInject: (p: FakeProvider, onWindow?: boolean) => void } }).window;
    const seen: number[] = [];
    const watcher = watchWallets((globalThis as unknown as { window: Window }).window, (w) => seen.push(w.length));
    win.lateInject(trust, false);
    expect(seen[seen.length - 1]).toBe(1);
    watcher.destroy();
  });

  it("discovers a provider that injects after the fast poll window (real mobile timing)", () => {
    // A Trust Wallet Android WebView was observed injecting around 9s, past the
    // 6s fast window. The watcher must keep a slow poll instead of stopping, or
    // the wallet is never seen.
    vi.useFakeTimers();
    try {
      const trust = makeProvider({ isTrust: true });
      cleanup = installWindow({});
      const win = (globalThis as unknown as { window: { lateInject: (p: FakeProvider, onWindow?: boolean) => void } }).window;
      const seen: number[] = [];
      const watcher = watchWallets((globalThis as unknown as { window: Window }).window, (w) => seen.push(w.length));

      vi.advanceTimersByTime(6500);
      expect(seen[seen.length - 1]).toBe(0);

      // Inject without firing `ethereum#initialized`: only the poll can find it.
      (win as unknown as { trustwallet?: { ethereum: FakeProvider } }).trustwallet = { ethereum: trust };
      vi.advanceTimersByTime(LEGACY_SLOW_POLL_MS * 2);

      expect(seen[seen.length - 1]).toBe(1);
      watcher.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connect", () => {
  it("connects to a single available injected wallet", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    expect(wallet.address).toBe(ADDR);
    expect(wallet.chainId).toBe(MONAD_CHAIN_ID);
    expect(wallet.onMonad).toBe(true);
    expect(wallet.kind).toBe("injected");
    expect(provider.calls.some((c) => c.method === "eth_requestAccounts")).toBe(true);
  });

  it("requires a choice when several wallets are present", async () => {
    cleanup = installWindow({
      providers: [
        { info: { uuid: "u1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: makeProvider() },
        { info: { uuid: "u2", name: "Rabby", icon: "", rdns: "io.rabby" }, provider: makeProvider() },
      ],
    });
    await expect(Wallet.connect()).rejects.toMatchObject({ walletCode: "wallet_not_found" });
  });

  it("selects a wallet by rdns", async () => {
    const rabby = makeProvider();
    cleanup = installWindow({
      providers: [
        { info: { uuid: "u1", name: "MetaMask", icon: "", rdns: "io.metamask" }, provider: makeProvider() },
        { info: { uuid: "u2", name: "Rabby", icon: "", rdns: "io.rabby" }, provider: rabby },
      ],
    });
    const wallet = await Wallet.connect({ walletId: "io.rabby" });
    expect(wallet.walletId).toBe("io.rabby");
    expect(rabby.calls.some((c) => c.method === "eth_requestAccounts")).toBe(true);
  });

  it("throws wallet_not_found when no wallet is installed", async () => {
    cleanup = installWindow({});
    await expect(Wallet.connect()).rejects.toBeInstanceOf(WalletError);
  });

  it("surfaces a user rejection at connect with its own code", async () => {
    cleanup = installLegacyWindow(makeProvider({ rejectConnect: { code: 4001 } }));
    await expect(Wallet.connect()).rejects.toMatchObject({ walletCode: "wallet_rejected" });
  });
});

describe("Monad enforcement", () => {
  it("does nothing when already on Monad", async () => {
    const provider = makeProvider({ chainId: "0x8f" });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await wallet.ensureMonadChain();
    expect(provider.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(false);
  });

  it("switches a wallet that is on another chain", async () => {
    const provider = makeProvider({ chainId: "0x1" });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    expect(wallet.onMonad).toBe(false);
    await wallet.ensureMonadChain();
    expect(wallet.onMonad).toBe(true);
    expect(provider.calls.some((c) => c.method === "wallet_switchEthereumChain")).toBe(true);
  });

  it("adds Monad when the wallet does not know the chain (4902)", async () => {
    const provider = makeProvider({ chainId: "0x1", rejectSwitch: { code: 4902 } });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await wallet.ensureMonadChain();
    expect(provider.calls.some((c) => c.method === "wallet_addEthereumChain")).toBe(true);
    expect(wallet.onMonad).toBe(true);
  });

  it("refuses to proceed when the switch is declined", async () => {
    const provider = makeProvider({ chainId: "0x1", rejectSwitch: { code: 4001, message: "User rejected" } });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await expect(wallet.ensureMonadChain()).rejects.toMatchObject({ walletCode: "wallet_wrong_chain" });
  });
});

describe("sendCalls", () => {
  it("sends prepared calls in order and returns the hashes", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    const result = await wallet.sendCalls([
      { to: "0x7547", data: "0x095ea7b3", value: "0" },
      { to: "0xrouter", data: "0x5023b4df", value: "0" },
    ]);
    expect(result.txHashes).toHaveLength(2);
    expect(result.txHashes.every((h) => /^0x[0-9a-fA-F]{64}$/.test(h))).toBe(true);
    const sends = provider.calls.filter((c) => c.method === "eth_sendTransaction");
    expect(sends).toHaveLength(2);
  });

  it("omits `data` for a plain native transfer and encodes value as hex", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await wallet.sendCalls([{ to: ADDR, data: "0x", value: "1000000000000000000" }]);
    const send = provider.calls.find((c) => c.method === "eth_sendTransaction")!;
    const params = (send.params as unknown[])[0] as { data?: string; value?: string; from: string };
    expect(params.data).toBeUndefined();
    expect(params.value).toBe("0xde0b6b3a7640000");
    expect(params.from).toBe(ADDR);
  });

  it("reports a user rejection as wallet_rejected, not a generic error", async () => {
    const provider = makeProvider({ rejectSend: { code: 4001 } });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await expect(wallet.sendCalls([{ to: ADDR, data: "0x", value: "0" }])).rejects.toMatchObject({ walletCode: "wallet_rejected" });
  });

  it("re-checks the chain before sending", async () => {
    const provider = makeProvider({ chainId: "0x1" });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    // A wallet that will not switch must never send.
    provider.request = (() => Promise.reject(Object.assign(new Error("User rejected"), { code: 4001 }))) as never;
    await expect(wallet.sendCalls([{ to: ADDR, data: "0x", value: "0" }])).rejects.toMatchObject({ walletCode: "wallet_wrong_chain" });
  });

  /**
   * Trust Wallet RPC independence. A page-world provider answers `eth_chainId`
   * by proxying to its own node (monad.twnodes.com); when that read fails the
   * SDK must still send — the chain was not reported as *wrong*, it was
   * *unknown*, and the request carries chainId 143 explicitly.
   */
  it("sends through a wallet whose own chain read fails (Trust Wallet)", async () => {
    const provider = makeProvider({ failChainId: true });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    const result = await wallet.sendCalls([{ to: ADDR, data: "0x", value: "0" }]);
    expect(result.txHashes).toHaveLength(1);
    const send = provider.calls.find((c) => c.method === "eth_sendTransaction")!;
    const params = (send.params as unknown[])[0] as { chainId?: string };
    // The chain identity travels with the request.
    expect(params.chainId).toBe("0x8f");
  });

  it("does not treat an unreadable chain as the wrong chain", async () => {
    const provider = makeProvider({ failChainId: true });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    // No throw: an unreadable chain is unknown, not wrong.
    await expect(wallet.ensureMonadChain()).resolves.toBeUndefined();
  });

  /**
   * Mission 24. When the caller has prepared the envelope (gas / EIP-1559 fees /
   * nonce) with its own RPC, the SDK must forward those fields verbatim so the
   * wallet has nothing left to estimate — the `monad.twnodes.com` failure.
   */
  it("forwards caller-prepared gas, fees and nonce to the wallet", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await wallet.sendCalls([
      {
        to: ADDR,
        data: "0x",
        value: "0",
        gas: "21000",
        maxFeePerGas: "122000000000",
        maxPriorityFeePerGas: "2000000000",
        nonce: "7",
      },
    ]);
    const send = provider.calls.find((c) => c.method === "eth_sendTransaction")!;
    const params = (send.params as unknown[])[0] as Record<string, string>;
    expect(params.gas).toBe("0x5208");
    expect(params.maxFeePerGas).toBe("0x1c67c44400");
    expect(params.maxPriorityFeePerGas).toBe("0x77359400");
    expect(params.nonce).toBe("0x7");
  });

  it("drops a malformed envelope field rather than forwarding a bad number", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await wallet.sendCalls([
      { to: ADDR, data: "0x", value: "0", gas: "not-a-number", maxFeePerGas: "" },
    ]);
    const send = provider.calls.find((c) => c.method === "eth_sendTransaction")!;
    const params = (send.params as unknown[])[0] as Record<string, string>;
    expect(params.gas).toBeUndefined();
    expect(params.maxFeePerGas).toBeUndefined();
    // The chain identity and value are still present.
    expect(params.chainId).toBe("0x8f");
  });

  /**
   * Mission 25. The wallet is asked to send only *after* the user authorised, so
   * a transport failure then does not prove nothing was broadcast. Trust Wallet's
   * native layer reports `Failed to connect to http://monad.twnodes.com/` after
   * password entry; the SDK must surface that as an unknown outcome — never a
   * definite "not sent" that would invite a double-spend.
   */
  it("surfaces a post-authorisation transport failure as an unknown outcome", async () => {
    const provider = makeProvider({
      rejectSend: { code: -32603, message: "Failed to connect to http://monad.twnodes.com/" },
    });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await expect(
      wallet.sendCalls([{ to: ADDR, data: "0x", value: "0" }]),
    ).rejects.toMatchObject({ walletCode: "wallet_unknown_outcome" });
  });

  it("keeps a user rejection distinct from an unknown outcome", async () => {
    const provider = makeProvider({ rejectSend: { code: 4001 } });
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await expect(
      wallet.sendCalls([{ to: ADDR, data: "0x", value: "0" }]),
    ).rejects.toMatchObject({ walletCode: "wallet_rejected" });
  });
});

describe("account and chain change handling", () => {
  it("notifies on an account change", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    let seen: string | null | undefined;
    wallet.onAccountsChanged((a) => (seen = a));
    const next = "0x0000000000000000000000000000000000000001";
    provider.emit("accountsChanged", [next]);
    expect(seen).toBe(next);
    expect(wallet.address).toBe(next);
  });

  it("notifies on a chain change", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    let seen: number | undefined;
    wallet.onChainChanged((c) => (seen = c));
    provider.emit("chainChanged", "0x1");
    expect(seen).toBe(1);
    expect(wallet.onMonad).toBe(false);
  });
});

describe("disconnect", () => {
  it("removes listeners and reports no error", async () => {
    const provider = makeProvider();
    cleanup = installLegacyWindow(provider);
    const wallet = await Wallet.connect();
    await expect(wallet.disconnect()).resolves.toBeUndefined();
  });
});

describe("pure helpers", () => {
  it("parses a hex chain id, and the decimal number WalletConnect returns", () => {
    expect(chainIdFromHex("0x8f")).toBe(143);
    expect(chainIdFromHex("nope")).toBeUndefined();
    // WalletConnect answers `eth_chainId` with a decimal number, not hex.
    expect(chainIdFromHex(143)).toBe(143);
    expect(chainIdFromHex("143")).toBe(143);
  });

  it("identifies Monad", () => {
    expect(isMonadChainId(143)).toBe(true);
    expect(isMonadChainId(1)).toBe(false);
  });

  it("reads the first valid account", () => {
    expect(firstAccount(["0x" + "a".repeat(40)])).toBe("0x" + "a".repeat(40));
    expect(firstAccount(["not-an-address"])).toBeUndefined();
    expect(firstAccount("nope")).toBeUndefined();
  });

  it("recognizes a user rejection by code and by message", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection(new Error("User denied transaction signature"))).toBe(true);
    expect(isUserRejection(new Error("insufficient funds"))).toBe(false);
  });

  it("gives a Monad-specific message for an unknown chain", () => {
    expect(walletErrorMessage({ code: 4902 })).toMatch(/Monad Mainnet/);
    expect(walletErrorMessage({ code: 4001 })).toMatch(/rejected/i);
  });
});
