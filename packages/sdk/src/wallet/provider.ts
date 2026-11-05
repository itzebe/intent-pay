/**
 * The wallet layer: connect a compatible wallet, enforce Monad Mainnet, and sign
 * the calls the API prepared.
 *
 * Design constraints, carried over from the Intent Pay application itself:
 *
 *  - **EIP-1193 only.** Every wallet — an injected extension, or WalletConnect —
 *    is driven through the same `{ request }` surface. There is no second
 *    signing path and no bespoke per-wallet code.
 *  - **EIP-6963 discovery.** A page may host several extensions at once; they
 *    announce themselves so the user can choose, instead of racing over the one
 *    `window.ethereum` slot.
 *  - **The user authorizes every transaction.** The SDK prepares nothing and
 *    signs nothing on its own; it hands the prepared calls to the wallet, which
 *    shows its own prompt. A rejection is a first-class outcome.
 *  - **No key material.** The SDK never asks for, reads or stores a private key
 *    or seed phrase. There is no code path that could.
 */

import type { Eip1193Provider } from "./eip6963.js";

export type { Eip1193Provider, DiscoveredWallet } from "./eip6963.js";

/** The chain the SDK enforces. */
export const MONAD_CHAIN_ID = 143 as const;

/** The EIP-3085 payload to add Monad Mainnet to a wallet. */
export function monadAddChainParams() {
  return {
    chainId: "0x" + MONAD_CHAIN_ID.toString(16),
    chainName: "Monad",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: ["https://rpc.monad.xyz"],
    blockExplorerUrls: ["https://monadscan.com"],
  };
}

/**
 * Parse a chain id into a number, or undefined when malformed.
 *
 * EIP-1193 mandates a hex quantity (`0x8f`), which injected wallets honour.
 * WalletConnect does **not**: its UniversalProvider answers `eth_chainId` with
 * `parseInt(...)` — a decimal *number* (143). A hex-only parser returned
 * `undefined` for a WalletConnect session, so a connected mobile wallet was
 * reported as the wrong network. Accept the hex form and the decimal number.
 */
export function chainIdFromHex(hex: unknown): number | undefined {
  if (typeof hex === "number") {
    return Number.isSafeInteger(hex) && hex >= 0 ? hex : undefined;
  }
  if (typeof hex !== "string") return undefined;
  if (/^0x[0-9a-fA-F]+$/.test(hex)) {
    const n = parseInt(hex, 16);
    return Number.isFinite(n) ? n : undefined;
  }
  if (/^[0-9]+$/.test(hex)) {
    const n = parseInt(hex, 10);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/** True when a chain id is Monad Mainnet. */
export function isMonadChainId(chainId: number | undefined): boolean {
  return chainId === MONAD_CHAIN_ID;
}

/** The first valid address from an `eth_accounts` / `eth_requestAccounts` reply. */
export function firstAccount(accounts: unknown): `0x${string}` | undefined {
  if (!Array.isArray(accounts)) return undefined;
  const first = accounts.find((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a));
  return first ? (first as `0x${string}`) : undefined;
}

/**
 * A user rejection is a deliberate act, not an error. It keeps its own message
 * so a caller can branch on it (`WalletError.walletCode === "wallet_rejected"`)
 * rather than showing a scary generic failure.
 */
export function isUserRejection(err: unknown): boolean {
  const code = (err as { code?: number | string })?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return true;
  const message = String((err as { message?: string })?.message ?? "");
  return /user rejected|user denied|rejected the request/i.test(message);
}

/** A short, client-safe message for a wallet failure. */
export function walletErrorMessage(err: unknown): string {
  if (isUserRejection(err)) return "You rejected the request in your wallet.";
  const code = (err as { code?: number })?.code;
  if (code === 4902 || /unrecognized chain|chain.*not.*added/i.test(String((err as { message?: string })?.message ?? ""))) {
    return "Monad Mainnet isn't in your wallet yet. Add it to continue.";
  }
  return "The wallet could not complete the request. Try again.";
}

/** Options for connecting a wallet. */
export type ConnectOptions = {
  /**
   * Prefer a specific wallet by EIP-6963 id / rdns (e.g. `io.metamask`). When
   * omitted, the only available wallet is chosen; if several exist and none is
   * named, the call throws so the caller can present a chooser.
   */
  walletId?: string;
  /** Explicitly request a WalletConnect session (mobile/QR) instead of injected. */
  walletConnect?: WalletConnectOptions;
  /** The EIP-6963 id the last session used, for silent re-attach. */
  restoreId?: string;
};

/** Options for a WalletConnect session. */
export type WalletConnectOptions = {
  /** The Reown project id (public). Required for WalletConnect. */
  projectId: string;
  /** Chain to offer. Defaults to Monad Mainnet (143). */
  chains?: number[];
  /** Shown in the wallet during the session approval. */
  metadata?: { name: string; description: string; url: string; icons: string[] };
};

/** A connected, Monad-enforced wallet handle. */
export type WalletConnection = {
  /** The active account. */
  address: `0x${string}`;
  /** The chain id, always Monad Mainnet once `ensureMonadChain()` has succeeded. */
  chainId: number;
  /** How this connection was made. */
  kind: "injected" | "walletconnect";
  /** The EIP-6963 id / rdns, when known. */
  walletId?: string;
  /** The underlying EIP-1193 provider. Exposed for advanced use. */
  provider: Eip1193Provider;
};

/** The EIP-1193 `request` signature, narrowed for the calls this SDK makes. */
export type RequestArguments = { method: string; params?: unknown[] | object };
