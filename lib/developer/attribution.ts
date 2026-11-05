import { getStore } from "@/lib/store";
import { derivePaymentAddress, validatePaymentXpub } from "./xpub";

/**
 * Checkout-specific attribution: a unique payment destination per order.
 *
 * A checkout is paid to a destination that is unique to that order, derived from
 * the merchant's own watch-only `xpub`. Attribution then has a hard, structural
 * answer — "was *this* order's unique address funded?" — instead of the weak
 * proxy "was the merchant's shared recipient paid the right amount recently?".
 *
 * Intent Pay never holds a spend key. It derives from the public key only, so a
 * derived address can be watched but never spent from by Intent Pay; the merchant
 * sweeps it with their own wallet. That is what keeps this non-custodial.
 *
 * When a merchant has not registered an xpub, `allocateAttributionAddress`
 * returns `null` and the checkout keeps the shared-recipient behaviour. That path
 * is weaker and is reported honestly (`capabilities`, the checkout view), never
 * presented as equivalent.
 */

export type Allocation = { address: string; index: number };

/**
 * How many times to retry the index reservation under contention. Each retry is a
 * compare-and-swap on `nextDerivationIndex`; a handful of concurrent checkout
 * creations converge quickly, and a persistent loser is a real fault, not load.
 */
const MAX_ALLOCATION_ATTEMPTS = 8;

/**
 * Reserve the next derivation index for a developer and return its address.
 *
 * The reservation is a compare-and-swap: read the current index, then update the
 * row **only if it still holds that index** (`update` returns the rows changed).
 * A concurrent allocation that moved the index first makes this update match zero
 * rows, so we re-read and try the next index. The index is therefore handed out
 * exactly once even under concurrency, and two checkouts can never share a
 * destination. The database also enforces it: `attribution_address` is unique.
 *
 * Returns `null` when the developer has no payment xpub (attribution not opted
 * in), so callers fall back to the shared recipient explicitly.
 */
export async function allocateAttributionAddress(developerId: string, now = Date.now()): Promise<Allocation | null> {
  const store = getStore();
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const developer = await store.findOne("apiDevelopers", { id: developerId });
    if (!developer || !developer.paymentXpub) return null;

    const index = developer.nextDerivationIndex ?? 0;
    // Compare-and-swap: only advance if the index is still what we read.
    const changed = await store.update(
      "apiDevelopers",
      { id: developerId, nextDerivationIndex: index },
      { nextDerivationIndex: index + 1, updatedAt: now },
    );
    if (changed === 0) continue; // lost the race — re-read and retry.

    return { address: derivePaymentAddress(developer.paymentXpub, index), index };
  }
  throw new Error("Could not reserve a checkout destination — too much contention on the payment xpub index.");
}

/** Read the address a checkout must be paid at, or null for shared-recipient mode. */
export function attributionDestination(attributionAddress: string | null | undefined): string | null {
  return attributionAddress && attributionAddress.trim() ? attributionAddress.trim().toLowerCase() : null;
}

/** Register (or clear) a developer's payment xpub. Validates it is public-only. */
export async function setPaymentXpub(
  developerId: string,
  xpub: string | null,
  now = Date.now(),
): Promise<{ ok: true; paymentXpub: string | null } | { ok: false; reason: string }> {
  const store = getStore();
  if (xpub === null || xpub.trim() === "") {
    await store.update("apiDevelopers", { id: developerId }, { paymentXpub: null, updatedAt: now });
    return { ok: true, paymentXpub: null };
  }
  const valid = validatePaymentXpub(xpub);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  await store.update("apiDevelopers", { id: developerId }, { paymentXpub: valid.normalized, updatedAt: now });
  return { ok: true, paymentXpub: valid.normalized };
}
