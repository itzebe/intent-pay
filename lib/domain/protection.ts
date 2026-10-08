/**
 * Execution protection.
 *
 * The product goal is that an MEV/sandwich attacker cannot make the recipient
 * receive drastically less while the app still reports success. That is
 * enforced by the *transaction*, not the UI:
 *
 *   - every swap carries a real on-chain `amountOutMinimum` (or
 *     `amountInMaximum`) derived from a bounded slippage tolerance,
 *   - a route whose live price impact exceeds a configurable threshold is
 *     blocked *before signing*,
 *   - a stale quote forces a fresh quote and a rebuilt transaction,
 *   - delivery is proven from the confirmed receipt.
 *
 * MEV / private order flow is reported as an explicit capability state, never a
 * boolean. There is currently no MEV-protected submission path available for
 * Monad (see `resolveMevProtection`), so the app reports
 * `MEV_PROTECTION_UNAVAILABLE` and leans on the protections above. If a private
 * submission endpoint is ever configured it is selected here and only then is
 * `MEV_PROTECTION_ACTIVE` reported.
 *
 * This module is pure and client-safe so the exact same rules run in the
 * browser signing guard and in unit tests.
 */

// ---------------------------------------------------------------------------
// Slippage
// ---------------------------------------------------------------------------

const BPS = 10_000;

/** Default slippage tolerance (0.5%). Tight on purpose: wide slippage is room
 * for a sandwich. */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Hard ceiling (5%). Slippage is never allowed to exceed this, even if a
 * caller asks for it — widening slippage is exactly what enables a sandwich. */
export const MAX_SLIPPAGE_BPS = 500;

/**
 * The slippage tolerance to actually enforce, in basis points.
 *
 * This is deliberately *independent of price impact*. A high-impact route is
 * blocked (see `assessPriceImpact`), never made executable by loosening
 * slippage. The value is clamped to `MAX_SLIPPAGE_BPS` so a bad route can never
 * be rescued by a wide tolerance.
 */
export function resolveSlippageBps(requested?: number | null): number {
  const base =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : envInt("NEXT_PUBLIC_SLIPPAGE_BPS", DEFAULT_SLIPPAGE_BPS);
  return Math.min(Math.max(base, 1), MAX_SLIPPAGE_BPS);
}

/** The smallest output the on-chain swap will accept for `amount`, in base
 * units. Mirrors the limit encoded into the swap calldata. */
export function applySlippageOut(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(BPS - slippageBps)) / BigInt(BPS);
}

/** The largest input the on-chain swap will spend for `amount`, in base units. */
export function applySlippageIn(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(BPS + slippageBps)) / BigInt(BPS);
}

// ---------------------------------------------------------------------------
// Price impact
// ---------------------------------------------------------------------------

/** Default maximum acceptable price impact (3%). */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 300;

/** The configured price-impact ceiling, in basis points. */
export function maxPriceImpactBps(): number {
  return envInt("NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS", DEFAULT_MAX_PRICE_IMPACT_BPS);
}

export type PriceImpactAssessment = {
  /** The live impact fraction (0.012 === 1.2%), or null when unavailable. */
  value: number | null;
  /** The ceiling as a fraction. */
  max: number;
  /** True when the route may proceed (unknown impact does not block). */
  ok: boolean;
  /** True when the impact is known and exceeds the ceiling. */
  blocked: boolean;
  /** Impact as basis points, when known. */
  bps: number | null;
};

/**
 * Assess a route's live price impact against the configured ceiling.
 *
 * An unknown impact (`null`) is *not* treated as excessive — we do not invent a
 * number and we do not block a route we could not measure. A measured impact
 * above the ceiling is a hard block: the caller must refuse to sign rather than
 * quietly widen slippage.
 */
export function assessPriceImpact(value: number | null | undefined): PriceImpactAssessment {
  const maxBps = maxPriceImpactBps();
  const max = maxBps / BPS;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { value: null, max, ok: true, blocked: false, bps: null };
  }
  const bps = Math.round(value * BPS);
  const blocked = value > max;
  return { value, max, ok: !blocked, blocked, bps };
}

// ---------------------------------------------------------------------------
// MEV / private order flow
// ---------------------------------------------------------------------------

/**
 * `MEV_PROTECTION_ACTIVE` only when the submitted transaction genuinely goes
 * through a private / MEV-protected submission path. Otherwise
 * `MEV_PROTECTION_UNAVAILABLE` — never a cosmetic badge.
 */
export type MevProtectionState =
  | "MEV_PROTECTION_ACTIVE"
  | "MEV_PROTECTION_UNAVAILABLE";

export type MevProtection = {
  state: MevProtectionState;
  active: boolean;
  /** A private/protected submission endpoint is configured. */
  rpcConfigured: boolean;
  /** Honest, human-readable explanation of the current state. */
  reason: string;
};

/**
 * Resolve the MEV / private-order-flow capability for Monad.
 *
 * As of now there is **no** production private-submission mechanism for Monad
 * that this application can safely use, so this returns
 * `MEV_PROTECTION_UNAVAILABLE` — deliberately, and unconditionally:
 *
 *   - Monad has no public mempool (transactions are forwarded to upcoming
 *     proposers), which reduces pre-inclusion visibility, but its encrypted
 *     mempool (BTX) and multiple-concurrent-proposer consensus (Cadence) are
 *     still research and are not live on mainnet;
 *   - Alchemy's built-in MEV protection covers Ethereum, Arbitrum, BSC, Base
 *     and Solana — **not Monad**;
 *   - no official Monad private RPC / builder-relay endpoint is documented.
 *
 * Crucially, even if a private endpoint were configured, this application
 * submits through the *user's wallet* (an injected provider), not through an
 * RPC we control — a dapp cannot force an injected wallet to broadcast
 * privately. Reporting `ACTIVE` from a config value alone would be a cosmetic
 * badge, so we never do. The state only becomes `MEV_PROTECTION_ACTIVE` when a
 * submission path that genuinely bypasses public visibility is wired in.
 *
 * Until then the app relies on the on-chain slippage bound, the price-impact
 * guard, quote freshness and on-chain delivery verification.
 */
export function resolveMevProtection(): MevProtection {
  return {
    state: "MEV_PROTECTION_UNAVAILABLE",
    active: false,
    rpcConfigured: false,
    reason:
      "No MEV-protected private submission path is available for Monad. Monad has no public mempool, but its encrypted mempool is not yet live, Alchemy's MEV protection does not cover Monad, and a dapp cannot force an injected wallet to broadcast privately. Protection relies on on-chain slippage bounds, a price-impact guard, quote freshness and on-chain delivery verification.",
  };
}

// ---------------------------------------------------------------------------
// Combined capability surface (for the review UI)
// ---------------------------------------------------------------------------

export type ExecutionProtection = {
  mev: MevProtection;
  slippage: {
    state: "SLIPPAGE_PROTECTION_ACTIVE";
    /** The tolerance actually encoded into the transaction. */
    bps: number;
    maxBps: number;
  };
  priceImpact: PriceImpactAssessment;
};

/**
 * Resolve the full protection surface for a quote. `requestedSlippageBps` is
 * the caller's preference; it is clamped and never influenced by price impact.
 */
export function resolveExecutionProtection(
  priceImpact: number | null | undefined,
  requestedSlippageBps?: number | null,
): ExecutionProtection {
  return {
    mev: resolveMevProtection(),
    slippage: {
      state: "SLIPPAGE_PROTECTION_ACTIVE",
      bps: resolveSlippageBps(requestedSlippageBps),
      maxBps: MAX_SLIPPAGE_BPS,
    },
    priceImpact: assessPriceImpact(priceImpact),
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export { BPS as PROTECTION_BPS };
