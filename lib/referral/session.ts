"use client";

import type { Address, WalletClient } from "viem";

/**
 * Establish a server session for the connected wallet.
 *
 * The wallet signs a fixed, human-readable message (no gas, no transaction). The
 * server recovers the signer and issues an httpOnly session cookie bound to the
 * address. The signature is sent once and never stored.
 *
 * Returns true when a valid session exists for `address` afterwards.
 */
export async function ensureSession(address: Address, walletClient: WalletClient): Promise<boolean> {
  try {
    const current = await fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json());
    if (current?.authenticated && String(current.address).toLowerCase() === address.toLowerCase()) {
      return true;
    }
  } catch {
    // Fall through to the challenge flow.
  }

  try {
    const challenge = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    }).then((r) => r.json());
    if (!challenge?.ok || !challenge.message || !challenge.nonce) return false;

    const signature = await walletClient.signMessage({ account: address, message: challenge.message });
    const verified = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, nonce: challenge.nonce, message: challenge.message, signature }),
    }).then((r) => r.json());
    return Boolean(verified?.ok && verified.authenticated);
  } catch {
    // The user declined, or the provider failed: no session, no crash.
    return false;
  }
}

/** Is there currently a valid session for this address? */
export async function hasSession(address: Address): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json());
    return Boolean(res?.authenticated && String(res.address).toLowerCase() === address.toLowerCase());
  } catch {
    return false;
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/session", { method: "DELETE" });
  } catch {
    /* best effort */
  }
}
