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

/**
 * The legacy injection signal a wallet fires on `window` once it has installed
 * itself. Wallets that predate EIP-6963 (Trust Wallet's in-app browser, older
 * Coinbase builds) set `window.ethereum` *after* first paint and then dispatch
 * this event, because a page that already ran cannot be expected to poll.
 */
export const LEGACY_INITIALIZED_EVENT = "ethereum#initialized";

/**
 * How long to keep polling for a provider that injects after first paint.
 *
 * `window.ethereum` may not exist when the SDK boots (a mobile in-app browser
 * injects on a later tick) and there is no cross-browser "provider ready" signal
 * every wallet emits, so a bounded poll is the only reliable fallback. It is
 * deliberately short and finite.
 */
export const LEGACY_POLL_MS = 250;
export const LEGACY_POLL_WINDOW_MS = 6000;

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

/**
 * A stable identity for a legacy provider. The index in
 * `window.ethereum.providers` is not stable across page loads, so a stored
 * connector id like `legacy:1` could restore the wrong wallet. The id is derived
 * from the provider's own identity flags when it has one.
 */
function legacyWalletId(provider: Eip1193Provider, index: number): string {
  // Same priority order as `legacyProviderName`, so a provider's id and its
  // displayed name can never disagree.
  if (provider.isRabby) return "legacy:rabby";
  if (provider.isMetaMask) return "legacy:metamask";
  if (provider.isCoinbaseWallet) return "legacy:coinbase";
  if (provider.isTrust || provider.isTrustWallet) return "legacy:trust";
  return `legacy:${index}`;
}

/** True when a value is a usable EIP-1193 provider. */
function isProvider(value: unknown): value is Eip1193Provider {
  return Boolean(value) && typeof (value as Eip1193Provider).request === "function";
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

/**
 * Legacy providers exposed only on `window.ethereum`.
 *
 * Trust Wallet's in-app browser is why this also reads
 * `window.trustwallet.ethereum`: the native layer sets `window.ethereum` from a
 * script that can run after the dapp has booted, and exposes the same provider
 * object on `window.trustwallet.ethereum` first. Reading both means a Trust
 * provider is discovered even on the tick where only one is present, and the
 * identity de-duplication keeps it a single entry.
 */
export function collectLegacyWallets(win: Window | undefined): DiscoveredWallet[] {
  const w = win as
    | { ethereum?: Eip1193Provider; trustwallet?: { ethereum?: Eip1193Provider } }
    | undefined;
  const out: DiscoveredWallet[] = [];
  const seen = new Set<Eip1193Provider>();

  const push = (provider: Eip1193Provider, index: number, identity?: { id: string; name: string }) => {
    if (!isProvider(provider) || seen.has(provider)) return;
    seen.add(provider);
    out.push({ id: identity?.id ?? legacyWalletId(provider, index), name: identity?.name ?? legacyProviderName(provider), icon: "", rdns: "", provider, announced: false });
  };

  // A Trust Wallet provider surfaced only on `window.trustwallet.ethereum` is
  // recorded first, with its identity taken from where it was found rather than
  // from provider flags (Trust sets `isMetaMask` for dapp compatibility), so its
  // stable id is used regardless of what `window.ethereum` holds.
  if (w?.trustwallet?.ethereum) {
    push(w.trustwallet.ethereum, -1, { id: "legacy:trust", name: "Trust Wallet" });
  }

  const eth = w?.ethereum;
  if (eth) {
    const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
    list.forEach((provider, index) => push(provider, index));
  }
  return out;
}

/**
 * Discover every injected wallet, then keep watching for new ones.
 *
 * Two arrival paths are covered, because a wallet that predates EIP-6963 does
 * not announce:
 *  - EIP-6963 announcements (some extensions inject after first paint);
 *  - a late legacy injection — a wallet may set `window.ethereum` (or
 *    `window.trustwallet.ethereum`) after the dapp boots, and, when it supports
 *    the convention, dispatch `ethereum#initialized`. Both are observed: the
 *    event gives an immediate update and a bounded poll catches a wallet that
 *    injects without firing it.
 *
 * Returns the initial snapshot plus a `destroy` that removes every listener and
 * clears the poll.
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
  const addLegacy = (): boolean => {
    let added = false;
    for (const w of collectLegacyWallets(win)) {
      if (byId.has(w.id)) continue;
      if ([...byId.values()].some((existing) => existing.provider === w.provider)) continue;
      byId.set(w.id, w);
      added = true;
    }
    return added;
  };
  const onAnnounce = (event: Event) => {
    const wallet = parseAnnouncement(event);
    if (!wallet || byId.has(wallet.id)) return;
    byId.set(wallet.id, wallet);
    snapshot();
  };
  const onLegacySignal = () => {
    if (addLegacy()) snapshot();
  };

  let poll: ReturnType<typeof setInterval> | undefined;
  let stopPoll: ReturnType<typeof setTimeout> | undefined;
  if (win) {
    addLegacy();
    win.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    win.addEventListener(LEGACY_INITIALIZED_EVENT, onLegacySignal);
    win.dispatchEvent(new Event(REQUEST_EVENT));
    poll = setInterval(() => {
      if (addLegacy()) snapshot();
    }, LEGACY_POLL_MS);
    (poll as { unref?: () => void } | undefined)?.unref?.();
    stopPoll = setTimeout(() => {
      if (poll) clearInterval(poll);
      poll = undefined;
    }, LEGACY_POLL_WINDOW_MS);
    (stopPoll as { unref?: () => void } | undefined)?.unref?.();
  }
  const wallets = snapshot();
  return {
    wallets,
    destroy: () => {
      if (poll) clearInterval(poll);
      if (stopPoll) clearTimeout(stopPoll);
      poll = undefined;
      stopPoll = undefined;
      if (win) {
        win.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
        win.removeEventListener(LEGACY_INITIALIZED_EVENT, onLegacySignal);
      }
    },
  };
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
