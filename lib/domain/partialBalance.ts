/**
 * Partial-balance splitting.
 *
 * A user may ask to send an asset they only partly hold ("Send 100 NEWCOIN")
 * while holding enough of *another* funded asset. Rather than refusing, the
 * payment can be satisfied by sending what they hold and obtaining the rest via
 * a swap.
 *
 * This module is pure and total: it decides *how much* must be sent directly
 * and *how much* must be swapped, from real on-chain numbers. It never invents
 * a balance, a price, or an amount. Whether the two legs can be executed
 * atomically is a wallet-capability question answered elsewhere (EIP-5792
 * batching); this module only computes the split.
 */

export type PartialSplit =
  | {
      /** The wallet already holds enough; a single direct transfer suffices. */
      mode: "direct";
      /** Token units to transfer (== target). */
      held: string;
      shortfall: "0";
    }
  | {
      /** The wallet holds none of the target; the whole amount must be swapped. */
      mode: "swap";
      held: "0";
      /** Token units the swap must deliver. */
      shortfall: string;
    }
  | {
      /** The wallet holds some; send it directly and swap the remainder. */
      mode: "split";
      /** Token units already held, sent directly to the recipient. */
      held: string;
      /** Token units that must be obtained by a swap. */
      shortfall: string;
    };

/** A decimal string is "effectively zero" when it parses to <= 0. */
function isZero(value: string): boolean {
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0;
}

/**
 * Split a target recipient amount into the part the wallet already holds and
 * the part that must be swapped.
 *
 * All three inputs are decimal strings in the *same token's* units. The
 * arithmetic is done on scaled integers so a float round-trip can never change
 * the amount the user asked for.
 */
export function splitPayment(
  target: string,
  held: string,
  decimals: number,
): PartialSplit {
  const targetUnits = toUnits(target, decimals);
  const heldUnits = toUnits(held, decimals);

  if (targetUnits <= 0n) {
    return { mode: "direct", held: "0", shortfall: "0" };
  }
  if (heldUnits <= 0n) {
    return { mode: "swap", held: "0", shortfall: fromUnits(targetUnits, decimals) };
  }
  if (heldUnits >= targetUnits) {
    return { mode: "direct", held: fromUnits(targetUnits, decimals), shortfall: "0" };
  }
  return {
    mode: "split",
    held: fromUnits(heldUnits, decimals),
    shortfall: fromUnits(targetUnits - heldUnits, decimals),
  };
}

/** True when a split needs a source asset other than the target itself. */
export function splitNeedsSource(split: PartialSplit): boolean {
  return split.mode === "swap" || split.mode === "split";
}

/**
 * Choose which funded asset should cover a shortfall: the most valuable
 * non-target holding. Returns null when nothing else is funded, so the caller
 * refuses rather than guessing.
 */
export function pickShortfallSource<T extends { symbol: string; address: string; usd: number }>(
  funded: T[],
  targetAddress: string,
): T | null {
  const key = (targetAddress ?? "").toLowerCase();
  const candidates = funded
    .filter((b) => (b.address ?? "").toLowerCase() !== key)
    .filter((b) => Number.isFinite(b.usd) && b.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return candidates[0] ?? null;
}

// --- scaled-integer helpers (never float) ----------------------------------

function toUnits(value: string, decimals: number): bigint {
  const clean = (value ?? "").trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return 0n;
  const [whole, frac = ""] = clean.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const wholePart = whole === "" ? "0" : whole;
  try {
    return BigInt(`${wholePart}${fracPadded}`.replace(/^0+/, "") || "0");
  } catch {
    return 0n;
  }
}

function fromUnits(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

export { isZero };
