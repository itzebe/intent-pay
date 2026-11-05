import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, checksumAddress } from "viem";

/**
 * Watch-only BIP32 derivation for per-checkout payment destinations.
 *
 * Checkout-specific attribution needs a destination that is **unique to one
 * order**, so a transfer can only ever settle the order it was created for. The
 * strongest non-custodial way to get one is to derive it from a key the
 * *merchant* controls: the merchant registers a public extended key (an `xpub`),
 * and Intent Pay derives a distinct address per checkout from it.
 *
 * Intent Pay holds **only the public key**. It can compute every address the
 * merchant will ever use, and can therefore watch them, but it can never spend
 * from them: the matching private keys live in the merchant's own wallet, which
 * is the only place that can sweep the funds. That is the "non-custodial"
 * requirement — no Intent Pay key ever controls a customer's money.
 *
 * An `xpub` is not a secret in the sense of a spending key, but it does reveal
 * every derived address, so it is stored and used server-side only and is never
 * returned by the API (see `publicDeveloper`).
 */

/** The purpose/coin/account prefix every derived address uses. */
const DEFAULT_DERIVATION_PREFIX = "m/0";

export type XpubValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

/**
 * Validate an extended public key.
 *
 * Only a *public* extended key is accepted — never a private one (`xprv`) and
 * never a seed or mnemonic. This is the guard that keeps Intent Pay from ever
 * being handed a spending key: a caller cannot smuggle one in through this field.
 */
export function validatePaymentXpub(input: string): XpubValidation {
  const value = (input ?? "").trim();
  if (!value) return { ok: false, reason: "Provide a payment xpub." };
  if (/^(xprv|yprv|zprv|tprv|uprv|vprv)/i.test(value)) {
    return { ok: false, reason: "That is a private key. Provide the public extended key (xpub) instead." };
  }
  if (/^(seed|mnemonic)\b/i.test(value)) {
    return { ok: false, reason: "Never provide a seed phrase. Provide the public extended key (xpub) instead." };
  }
  try {
    const key = HDKey.fromExtendedKey(value);
    // A valid extended *public* key has no private material.
    if (!key.publicKey || key.privateKey) {
      return { ok: false, reason: "That is not a public extended key." };
    }
    return { ok: true, normalized: value };
  } catch {
    return { ok: false, reason: "That is not a valid BIP32 extended public key." };
  }
}

/**
 * Derive the address at `index` from a payment xpub.
 *
 * Path is `m/0/<index>`: the `0` branch is the external/receiving chain, so the
 * merchant's own wallet shows these as its normal receive addresses. Throws on an
 * invalid xpub or index — callers validate the xpub before storing it, so a throw
 * here means a corrupt record, not user input.
 */
export function derivePaymentAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Derivation index must be a non-negative integer.");
  const root = HDKey.fromExtendedKey(xpub);
  const child = root.derive(`${DEFAULT_DERIVATION_PREFIX}/${index}`);
  if (!child.publicKey) throw new Error("Could not derive a public key from the payment xpub.");
  return publicKeyToAddress(child.publicKey);
}

/**
 * The Ethereum address for a secp256k1 public key.
 *
 * `@scure/bip32` yields a **33-byte compressed** point, while the address is the
 * last 20 bytes of `keccak256` over the **64-byte uncompressed** point (the
 * `0x04` prefix dropped). Passing the compressed form straight to a helper that
 * assumes 65 bytes silently hashes the wrong 32 bytes — the derived address is
 * then one the merchant's wallet cannot spend from. Decompressing first is what
 * makes every derived destination an address the merchant's own wallet controls.
 */
function publicKeyToAddress(compressed: Uint8Array): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressed).toRawBytes(false);
  const body = Buffer.from(uncompressed).toString("hex").slice(2); // drop the 0x04 prefix
  return checksumAddress(`0x${keccak256(`0x${body}`).slice(-40)}`);
}

/**
 * Derive several addresses at once (for a merchant previewing their destination
 * sequence, and for tests).
 */
export function derivePaymentAddresses(xpub: string, from: number, count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => derivePaymentAddress(xpub, from + i));
}
