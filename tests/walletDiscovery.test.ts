import { describe, expect, it, vi } from "vitest";
import {
  ANNOUNCE_EVENT,
  REQUEST_EVENT,
  collectLegacyWallets,
  legacyProviderName,
  parseAnnouncement,
  walletDisplayName,
  watchWallets,
  type Eip1193Provider,
} from "@/lib/wallet/eip6963";

/**
 * EIP-6963 discovery is pure of React, so it is exercised here against a fake
 * `window` — no browser or real wallet extension required. This is a MOCKED
 * test (a synthetic `window`); real-wallet verification is separate and
 * documented in the PR.
 */

/** A minimal fake provider that records nothing but is structurally EIP-1193. */
function fakeProvider(flags: Partial<Eip1193Provider> = {}): Eip1193Provider {
  return { request: vi.fn(async () => []), ...flags };
}

/** A fake `window` supporting just the event API discovery uses. */
function fakeWindow(ethereum?: Eip1193Provider) {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const dispatched: string[] = [];
  return {
    ethereum,
    addEventListener(type: string, handler: (e: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (e: Event) => void) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event: Event) {
      dispatched.push(event.type);
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    },
    _dispatched: dispatched,
    _announce(detail: unknown) {
      const event = new CustomEvent(ANNOUNCE_EVENT, { detail });
      for (const handler of listeners.get(ANNOUNCE_EVENT) ?? []) handler(event);
    },
  };
}

const detail = (uuid: string, rdns: string, name: string, provider: Eip1193Provider) => ({
  info: { uuid, rdns, name, icon: "data:image/svg+xml,<svg/>" },
  provider,
});

describe("legacyProviderName", () => {
  it("labels a legacy provider by its detection flag", () => {
    expect(legacyProviderName(fakeProvider({ isMetaMask: true }))).toBe("MetaMask");
    expect(legacyProviderName(fakeProvider({ isRabby: true }))).toBe("Rabby");
    expect(legacyProviderName(fakeProvider({ isCoinbaseWallet: true }))).toBe("Coinbase Wallet");
    expect(legacyProviderName(fakeProvider({ isTrust: true }))).toBe("Trust Wallet");
    expect(legacyProviderName(fakeProvider())).toBe("Browser wallet");
  });

  it("prefers Rabby over the MetaMask flag (Rabby sets isMetaMask too)", () => {
    expect(legacyProviderName(fakeProvider({ isMetaMask: true, isRabby: true }))).toBe("Rabby");
  });
});

describe("walletDisplayName", () => {
  it("maps a known rdns to its friendly name", () => {
    expect(walletDisplayName({ uuid: "u", rdns: "io.metamask", name: "MetaMask", icon: "" })).toBe(
      "MetaMask",
    );
    expect(walletDisplayName({ uuid: "u", rdns: "com.trustwallet.app", name: "Trust", icon: "" })).toBe(
      "Trust Wallet",
    );
  });

  it("falls back to the announced name for an unknown rdns", () => {
    expect(walletDisplayName({ uuid: "u", rdns: "io.new", name: "New Wallet", icon: "" })).toBe(
      "New Wallet",
    );
  });
});

describe("parseAnnouncement", () => {
  it("parses a well-formed announcement", () => {
    const provider = fakeProvider();
    const wallet = parseAnnouncement(
      new CustomEvent(ANNOUNCE_EVENT, { detail: detail("uuid-1", "io.metamask", "MetaMask", provider) }),
    );
    expect(wallet).not.toBeNull();
    expect(wallet!.id).toBe("uuid-1");
    expect(wallet!.name).toBe("MetaMask");
    expect(wallet!.announced).toBe(true);
    expect(wallet!.provider).toBe(provider);
  });

  it("rejects a malformed announcement (no provider.request)", () => {
    expect(parseAnnouncement(new CustomEvent(ANNOUNCE_EVENT, { detail: { info: {} } }))).toBeNull();
    expect(parseAnnouncement(new CustomEvent(ANNOUNCE_EVENT, { detail: undefined }))).toBeNull();
  });

  it("falls back to rdns when no uuid is present", () => {
    const wallet = parseAnnouncement(
      new CustomEvent(ANNOUNCE_EVENT, {
        detail: detail("", "io.rabby", "Rabby", fakeProvider()),
      }),
    );
    expect(wallet!.id).toBe("io.rabby");
  });
});

describe("collectLegacyWallets", () => {
  it("returns nothing when there is no window.ethereum", () => {
    expect(collectLegacyWallets(undefined)).toEqual([]);
    expect(collectLegacyWallets({} as unknown as Window)).toEqual([]);
  });

  it("expands a multi-provider window.ethereum into individually selectable wallets", () => {
    const mm = fakeProvider({ isMetaMask: true });
    const cb = fakeProvider({ isCoinbaseWallet: true });
    const eth = fakeProvider({ providers: [mm, cb] });
    const wallets = collectLegacyWallets({ ethereum: eth } as unknown as Window);
    expect(wallets.map((w) => w.name)).toEqual(["MetaMask", "Coinbase Wallet"]);
    expect(wallets.map((w) => w.id)).toEqual(["legacy:0", "legacy:1"]);
    expect(wallets.every((w) => w.announced === false)).toBe(true);
  });

  it("treats a single provider as one legacy wallet", () => {
    const wallets = collectLegacyWallets({
      ethereum: fakeProvider({ isMetaMask: true }),
    } as unknown as Window);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].name).toBe("MetaMask");
  });
});

describe("watchWallets", () => {
  it("dispatches the request event and collects announced wallets", () => {
    const win = fakeWindow();
    const { wallets, destroy } = watchWallets(win as unknown as Window);
    expect(win._dispatched).toContain(REQUEST_EVENT);
    expect(wallets).toEqual([]);

    // A wallet that announces after first paint is picked up and reported.
    const seen: number[] = [];
    const watcher = watchWallets(win as unknown as Window, (w) => seen.push(w.length));
    win._announce(detail("uuid-1", "io.metamask", "MetaMask", fakeProvider()));
    expect(seen).toContain(1);
    watcher.destroy();
    destroy();
  });

  it("includes a legacy provider alongside announced ones, de-duplicated by identity", () => {
    const legacyProvider = fakeProvider({ isMetaMask: true });
    const win = fakeWindow(legacyProvider);
    const { wallets } = watchWallets(win as unknown as Window);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].announced).toBe(false);

    // The same provider announces itself via EIP-6963 — it must not appear twice.
    win._announce(detail("uuid-mm", "io.metamask", "MetaMask", legacyProvider));
    const after = watchWallets(win as unknown as Window).wallets;
    expect(after).toHaveLength(1);
  });

  it("ignores a duplicate uuid", () => {
    const win = fakeWindow();
    const seen: number[] = [];
    watchWallets(win as unknown as Window, (w) => seen.push(w.length));
    win._announce(detail("uuid-1", "io.metamask", "MetaMask", fakeProvider()));
    win._announce(detail("uuid-1", "io.metamask", "MetaMask", fakeProvider()));
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("stops reporting after destroy", () => {
    const win = fakeWindow();
    const seen: number[] = [];
    const watcher = watchWallets(win as unknown as Window, (w) => seen.push(w.length));
    watcher.destroy();
    const before = seen.length;
    win._announce(detail("uuid-x", "io.rabby", "Rabby", fakeProvider()));
    expect(seen.length).toBe(before);
  });
});
