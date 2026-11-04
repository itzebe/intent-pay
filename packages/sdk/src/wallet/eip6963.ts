/**
 * EIP-6963 multi-injected-provider discovery.
 *
 * A page may host several wallet extensions at once (MetaMask, Rabby, Coinbase
 * Wallet, Trust Wallet, …), all of which would otherwise fight over the single
 * `window.ethereum` slot. EIP-6963 replaces that race with a two-event
 * handshake: the dapp dispatches `eip6963:requestProvider`, and each wallet
 * re-announces itself with a frozen `{ info, provider }` detail.
 *
 * This is the same rule the Intent Pay application uses, extracted so an SDK
 * consumer discovers wallets identically. It always degrades to the legacy
 * `window.ethereum` provider (plus its `providers` array) so a wallet that does
 * not implement EIP-6963 is still discoverable.
 */

/** The minimal EIP-1193 surface the SDK uses. */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isTrust?: boolean;
  isTrustWallet?: boolean;
  providers?: Eip1193Provider[];
  [key: string]: unknown;
};

/** EIP-6963 `EIP6963ProviderInfo`. */
export type Eip6963ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };

/** EIP-6963 `EIP6963ProviderDetail`. */
export type Eip6963ProviderDetail = { info: Eip6963ProviderInfo; provider: Eip1193Provider };

/** A discovered wallet, ready to be offered to the user. */
export type DiscoveredWallet = {
  id: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
  announced: boolean;
};

export const REQUEST_EVENT = "eip6963:requestProvider";
export const ANNOUNCE_EVENT = "eip6963:announceProvider";

/** Known reverse-DNS → friendly name. */
const RDNS_NAMES: Record<string, string> = {
  "io.metamask": "MetaMask",
  "io.rabby": "Rabby",
  "com.coinbase.wallet": "Coinbase Wallet",
  "com.trustwallet.app": "Trust Wallet",
  "com.bitget.web3": "Bitget Wallet",
  "io.zerion.wallet": "Zerion",
  "app.phantom": "Phantom",
  "com.okex.wallet": "OKX Wallet",
  "me.rainbow": "Rainbow",
};

/** Best-effort label for a legacy `window.ethereum` that did not announce. */
export function legacyProviderName(provider: Eip1193Provider): string {
  if (provider.isRabby) return "Rabby";
  if (provider.isMetaMask) return "MetaMask";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isTrust || provider.isTrustWallet) return "Trust Wallet";
  return "Browser wallet";
}

/** Friendly name for an EIP-6963 provider, falling back to the announced name. */
export function walletDisplayName(info: Eip6963ProviderInfo): string {
  return RDNS_NAMES[info.rdns] ?? info.name ?? "Browser wallet";
}

/** Parse an `eip6963:announceProvider` event into a wallet, or null when malformed. */
export function parseAnnouncement(event: Event): DiscoveredWallet | null {
  const detail = (event as CustomEvent).detail as Partial<Eip6963ProviderDetail> | undefined;
  if (!detail || typeof detail !== "object") return null;
  const { info, provider } = detail;
  if (!info || typeof info !== "object" || !provider || typeof provider.request !== "function") return null;
  const id = info.uuid || info.rdns;
  if (!id) return null;
  return { id, name: walletDisplayName(info), icon: info.icon ?? "", rdns: info.rdns ?? "", provider, announced: true };
}

/** Legacy providers exposed only on `window.ethereum`. */
export function collectLegacyWallets(win: Window | undefined): DiscoveredWallet[] {
  const eth = (win as { ethereum?: Eip1193Provider } | undefined)?.ethereum;
  if (!eth) return [];
  const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
  const out: DiscoveredWallet[] = [];
  list.forEach((provider, index) => {
    if (!provider || typeof provider.request !== "function") return;
    out.push({ id: `legacy:${index}`, name: legacyProviderName(provider), icon: "", rdns: "", provider, announced: false });
  });
  return out;
}

/**
 * Discover every injected wallet, then keep watching for new announcements.
 * Returns the initial snapshot plus a `destroy` that removes the listener.
 */
export function watchWallets(
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
  onChange?: (wallets: DiscoveredWallet[]) => void,
): { wallets: DiscoveredWallet[]; destroy: () => void } {
  const byId = new Map<string, DiscoveredWallet>();
  const snapshot = () => {
    const wallets = [...byId.values()];
    onChange?.(wallets);
    return wallets;
  };
  const addLegacy = () => {
    for (const w of collectLegacyWallets(win)) {
      if (byId.has(w.id)) continue;
      if ([...byId.values()].some((existing) => existing.provider === w.provider)) continue;
      byId.set(w.id, w);
    }
  };
  const onAnnounce = (event: Event) => {
    const wallet = parseAnnouncement(event);
    if (!wallet || byId.has(wallet.id)) return;
    byId.set(wallet.id, wallet);
    snapshot();
  };
  if (win) {
    addLegacy();
    win.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    win.dispatchEvent(new Event(REQUEST_EVENT));
  }
  const wallets = snapshot();
  return { wallets, destroy: () => void (win && win.removeEventListener(ANNOUNCE_EVENT, onAnnounce)) };
}

/**
 * Discover wallets and resolve once the current announcements have settled.
 *
 * EIP-6963 is asynchronous: wallets answer the request event on the next tick.
 * Awaiting a macrotask lets every already-injected wallet answer before the
 * snapshot is taken, so a chooser does not flicker from empty to populated.
 */
export async function discoverWallets(win: Window | undefined = typeof window !== "undefined" ? window : undefined): Promise<DiscoveredWallet[]> {
  const { wallets, destroy } = watchWallets(win);
  await new Promise((resolve) => setTimeout(resolve, 0));
  destroy();
  return wallets;
}
