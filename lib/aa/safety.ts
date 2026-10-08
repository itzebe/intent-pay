/**
 * Bounded-spend safety for ERC-20 gas.
 *
 * The cardinal rule: an ERC-20 paymaster must never be able to drain a wallet.
 * The maximum the paymaster may pull is bounded by:
 *   - a hard per-operation ceiling (absolute token amount), and
 *   - the user's actual balance,
 * and the bound is derived from the *quoted* cost, never from an unlimited
 * approval. `type(uint256).max` is refused outright.
 */

/** Absolute ceiling on a single ERC-20 gas spend, as a fraction of balance. */
export const MAX_GAS_FRACTION_OF_BALANCE = 0.5; // never more than half the balance

/** A small markup over the estimate to absorb oracle/rounding movement. */
export const GAS_SPEND_BUFFER_BPS = 2_000n; // +20%

/** Add a bounded buffer to an estimated cost. */
export function withGasBuffer(estimate: bigint, bufferBps: bigint = GAS_SPEND_BUFFER_BPS): bigint {
  if (estimate <= 0n) return 0n;
  return estimate + (estimate * bufferBps) / 10_000n;
}

export type SpendBoundInput = {
  /** Estimated token cost of the UserOperation, base units. */
  estimatedCost: bigint;
  /** The user's available balance of the gas token, base units. */
  balance: bigint;
  /** Operator-configured absolute ceiling, base units (optional). */
  configuredMax?: bigint;
};

export type SpendBoundResult =
  | { ok: true; maxSpend: bigint }
  | { ok: false; reason: string };

/**
 * Compute the maximum token amount the paymaster may pull, and refuse an
 * unsafe bound. Fails closed: an unknown/zero balance or cost yields a refusal
 * rather than an open-ended approval.
 */
export function boundGasSpend(input: SpendBoundInput): SpendBoundResult {
  const { estimatedCost, balance, configuredMax } = input;
  if (estimatedCost <= 0n) {
    return { ok: false, reason: "No live gas estimate is available for this token." };
  }
  if (balance <= 0n) {
    return { ok: false, reason: "You don't hold this gas token." };
  }

  const buffered = withGasBuffer(estimatedCost);
  let maxSpend = buffered;

  // Never exceed half the balance: a stale/malicious oracle rate must not be
  // able to take everything.
  const halfBalance = (balance * BigInt(Math.round(MAX_GAS_FRACTION_OF_BALANCE * 100))) / 100n;
  if (maxSpend > halfBalance) maxSpend = halfBalance;

  if (configuredMax !== undefined && configuredMax > 0n && maxSpend > configuredMax) {
    maxSpend = configuredMax;
  }

  if (maxSpend < estimatedCost) {
    return { ok: false, reason: "The safe spend limit is below the estimated gas cost." };
  }
  if (maxSpend > balance) {
    return { ok: false, reason: "The gas spend would exceed your balance." };
  }
  return { ok: true, maxSpend };
}

/**
 * Whether a proposal is safe: the bound must cover the estimate, stay within
 * balance, and never be an unlimited approval.
 */
export function isSafeSpend(maxSpend: bigint, balance: bigint, estimatedCost: bigint): boolean {
  const UNLIMITED = 2n ** 256n - 1n;
  if (maxSpend >= UNLIMITED) return false;
  if (maxSpend > balance) return false;
  if (maxSpend < estimatedCost) return false;
  return true;
}
