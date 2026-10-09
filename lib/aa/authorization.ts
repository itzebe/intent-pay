"use client";

import type { Address, Hex } from "viem";

/**
 * Real EIP-7702 authorization preparation for the ERC-20 gas path.
 *
 * viem's `prepareUserOperation` does NOT sign an authorization: when the smart
 * account exposes an `authorization` template and the account is not yet
 * deployed, it fills the UserOperation with a *placeholder* (`r=0xfff…`,
 * `s=0x7aaa…`, `yParity=1`) purely to estimate gas. That placeholder is not a
 * valid signature, so the EntryPoint/paymaster rejects the operation.
 *
 * The account owner is therefore responsible for producing the real, signed
 * authorization and passing it explicitly to `prepareUserOperation` /
 * `sendUserOperation`. This module is that step: it prepares, signs through the
 * supplied signer, and validates the result. It performs no submission.
 */

/**
 * An EIP-7702 authorization bound to the app's own nonce semantics: the `nonce`
 * is the authorization authority's EOA transaction nonce and is a `bigint`
 * throughout (viem's `SignedAuthorization` types it as `number`, but the
 * on-chain tuple is a `uint64`; keeping `bigint` avoids any precision loss).
 */
export type AaSignedAuthorization = {
  address: Address;
  chainId: number;
  nonce: bigint;
  r: Hex;
  s: Hex;
  yParity: number;
};

/** The maximum value EIP-7702 accepts for an authorization `nonce` (2^64 - 1). */
export const MAX_AUTHORIZATION_NONCE = 2n ** 64n - 1n;

/** The minimal authorization-signing surface the 7702 account needs. */
export type AuthorizationSigner = {
  /** The EOA that signs — for a 7702 self-executing authorization, the sender. */
  address: Address;
  /**
   * Signs an EIP-7702 authorization. Wallets expose this through a
   * wallet-specific JSON-RPC method (e.g. `eth_signAuthorization` or
   * `wallet_signAuthorization`); EIP-7702 does not standardize an RPC method.
   * `nonce` is the authority's EOA transaction nonce, a `bigint`.
   */
  signAuthorization: (
    authorization: { address: Address; chainId: number; nonce: bigint },
  ) => Promise<AaSignedAuthorization>;
};

export class AaAuthorizationError extends Error {
  /** A machine-readable reason the caller maps onto an honest UI state. */
  code:
    | "unsupported_signer" // the signer cannot sign an authorization at all
    | "signing_failed" // the signer rejected / the wallet call failed
    | "invalid_authorization" // a structurally invalid result was produced
    | "invalid_nonce"; // the authorization nonce is out of EIP-7702 range
  constructor(message: string, code: AaAuthorizationError["code"]) {
    super(message);
    this.name = "AaAuthorizationError";
    this.code = code;
  }
}

export type PreparedAuthorization = {
  authorization: AaSignedAuthorization;
  /** The exact authorization that was signed (for diagnostics/tests). */
  request: { address: Address; chainId: number; nonce: bigint };
};

/** True when the result carries a plausible ECDSA signature (not a viem stub). */
function hasSignature(value: unknown): value is AaSignedAuthorization {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  const r = a.r;
  const s = a.s;
  const y = a.yParity ?? a.v;
  const shapeOk =
    typeof r === "string" &&
    r.startsWith("0x") &&
    r.length >= 66 &&
    typeof s === "string" &&
    s.startsWith("0x") &&
    s.length >= 66 &&
    (typeof y === "number" || typeof y === "string" || typeof y === "bigint");
  if (!shapeOk) return false;
  return !isPlaceholderSignature(r as string, s as string);
}

/**
 * viem's `prepareUserOperation` fills an unsigned 7702 authorization with a
 * well-known placeholder (`r=0xffff...f000...`, `s=0x7aaa...`). It must never be
 * accepted as a real signature.
 */
export function isPlaceholderSignature(r: string, s: string): boolean {
  const rr = r.toLowerCase();
  const ss = s.toLowerCase();
  return rr.startsWith("0xfffffffffffffffffffffffffffffff") || ss.startsWith("0x7aaaaaaaaaaaaaaaa");
}

/** Normalise a signed authorization's parity (`yParity`) or `v` to 0/1. */
function normalizeYParity(signed: AaSignedAuthorization): number {
  const raw = (signed as unknown as { yParity?: unknown; v?: unknown }).yParity ?? (signed as unknown as { v?: unknown }).v;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n >= 27 ? n - 27 : n;
}

/**
 * Prepare and sign the EIP-7702 authorization that delegates the sender EOA to
 * `implementation`. The authorization is bound to the chain, the EOA and the
 * implementation address — a mismatch is rejected rather than silently reused.
 */
export async function prepareSignedAuthorization(input: {
  signer: AuthorizationSigner | undefined;
  owner: Address;
  chainId: number;
  implementation: Address;
  /**
   * The authorization authority's EOA transaction nonce (the account's pending
   * transaction count). This is NOT the UserOperation nonce.
   */
  nonce: bigint;
}): Promise<PreparedAuthorization> {
  const { signer, owner, chainId, implementation, nonce } = input;

  // EIP-7702 requires 0 <= nonce < 2^64. Reject before any signing attempt so an
  // out-of-range value can never reach a signed authorization or the bundler.
  if (typeof nonce !== "bigint" || nonce < 0n || nonce > MAX_AUTHORIZATION_NONCE) {
    throw new AaAuthorizationError(
      "The account's transaction nonce is outside the range EIP-7702 accepts.",
      "invalid_nonce",
    );
  }

  if (!signer || typeof signer.signAuthorization !== "function") {
    throw new AaAuthorizationError(
      "This wallet can't sign the EIP-7702 authorization required to pay the network fee in a token. Your wallet needs MON for network fees, or use a wallet that supports EIP-7702.",
      "unsupported_signer",
    );
  }

  // The authorization must be signed by the EOA that will delegate (the sender).
  if (signer.address && signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new AaAuthorizationError(
      "The authorization signer is not the payment account.",
      "invalid_authorization",
    );
  }

  const request = { address: implementation, chainId, nonce };

  let signed: AaSignedAuthorization;
  try {
    signed = await signer.signAuthorization(request);
  } catch (err) {
    throw new AaAuthorizationError(
      `The wallet didn't sign the EIP-7702 authorization${
        err instanceof Error && err.message ? `: ${err.message}` : "."
      }`,
      "signing_failed",
    );
  }

  if (!hasSignature(signed)) {
    throw new AaAuthorizationError(
      "The wallet returned an invalid EIP-7702 authorization signature.",
      "invalid_authorization",
    );
  }

  // Bind the authorization to the expected chain, account and implementation.
  const signedChain = Number(signed.chainId);
  const signedAddress = (signed.address ?? "") as string;
  if (Number.isFinite(signedChain) && signedChain !== chainId) {
    throw new AaAuthorizationError(
      "The EIP-7702 authorization was signed for the wrong chain.",
      "invalid_authorization",
    );
  }
  if (signedAddress && signedAddress.toLowerCase() !== implementation.toLowerCase()) {
    throw new AaAuthorizationError(
      "The EIP-7702 authorization targets the wrong account implementation.",
      "invalid_authorization",
    );
  }

  // The signed nonce must match what we asked for — a wallet must never silently
  // move the authorization to a different nonce.
  const signedNonce = toBigIntNonce(signed.nonce ?? nonce);
  if (signedNonce !== nonce) {
    throw new AaAuthorizationError(
      "The EIP-7702 authorization was signed for a different account nonce.",
      "invalid_authorization",
    );
  }

  return {
    authorization: {
      address: (signedAddress || implementation) as Address,
      chainId: Number.isFinite(signedChain) ? signedChain : chainId,
      nonce: signedNonce,
      r: signed.r as Hex,
      s: signed.s as Hex,
      yParity: normalizeYParity(signed),
    },
    request,
  };
}

/** Normalise a nonce that may arrive as bigint, number, or 0x-hex to bigint. */
function toBigIntNonce(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length) {
    return value.startsWith("0x") ? BigInt(value) : BigInt(value);
  }
  return 0n;
}
