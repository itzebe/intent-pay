"use client";

import type { Address } from "viem";
import { NETWORKS } from "@/lib/config/chains";

/**
 * Pure helpers for the wallet connection lifecycle.
 *
 * Kept free of React and of any provider object so every rule the UI depends on
 * — how a chain id is parsed, which chain counts as Monad, how an empty account
 * list is interpreted, which wallet a restored page should re-attach to — is
 * unit-testable without a browser or a real wallet.
 */

/** Parse a hex chain id (`0x8f`) into a number, or undefined when malformed. */
export function chainIdFromHex(hex: unknown): number | undefined {
  if (typeof hex !== "string") return undefined;
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) return undefined;
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : undefined;
}

/** True when a chain id is the Monad Mainnet chain (143). */
export function isMonadChainId(chainId: number | undefined): boolean {
  return chainId === NETWORKS.mainnet.chainId;
}

/** The first valid address from an `eth_accounts` / `eth_requestAccounts` reply. */
export function firstAccount(accounts: unknown): Address | undefined {
  if (!Array.isArray(accounts)) return undefined;
  const first = accounts.find((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a));
  return first ? (first as Address) : undefined;
}

/**
 * The connection status implied by an account list: an empty list is a
 * disconnect, a non-empty one is connected. Never a half state.
 */
export function statusForAccounts(accounts: unknown): "connected" | "disconnected" {
  return firstAccount(accounts) ? "connected" : "disconnected";
}

/**
 * Which discovered wallet a page load should silently re-attach to.
 *
 * `storedId` is the id the user last chose (persisted client-side). We only
 * restore it when it still exists *and* still reports an authorised account —
 * otherwise the user is left disconnected rather than shown a phantom session.
 */
export function pickRestorableWallet(
  storedId: string | null,
  wallets: { id: string }[],
): string | null {
  if (!storedId) return null;
  return wallets.some((w) => w.id === storedId) ? storedId : null;
}

/** A stable, human-friendly label for a wallet's connection kind. */
export type WalletKind = "injected" | "walletconnect";

/**
 * A message for a failed connection attempt. A user rejection keeps its own
 * copy (it is a deliberate act, not an error); anything else is generic and
 * never echoes a raw provider string.
 */
export function connectionErrorMessage(err: unknown): string {
  const code = (err as { code?: number })?.code;
  if (code === 4001) return "You rejected the connection request.";
  return "Couldn't connect to the wallet. Try again or choose another wallet.";
}
