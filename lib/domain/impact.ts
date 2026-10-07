/**
 * Price impact.
 *
 * Price impact is the difference between the rate a trade actually executes at
 * and the marginal (spot) rate it would get at an infinitesimal size. It is
 * *not* fees and not slippage: it is the cost of consuming liquidity.
 *
 * We only ever compute it from real quoter output — a trade quote and a tiny
 * "spot" probe quoted through the same path. When the probe cannot be produced
 * (e.g. it rounds to zero base units) the caller gets `null` and the UI says
 * "unavailable" rather than inventing a number.
 */

/** A near-spot probe is this fraction of the trade size (0.01%). */
const PROBE_DIVISOR = 10_000n;

/**
 * Compare the average execution rate of a trade against a near-spot rate.
 *
 * `tradeIn`/`tradeOut` are the trade's base units; `probeIn`/`probeOut` are a
 * much smaller exact-input quote on the *same* path. Returns a fraction
 * (0.0012 === 0.12%), or null when it cannot be computed. Never negative — a
 * better-than-spot fill (e.g. price moved in our favour between the two quotes)
 * is reported as 0 impact.
 */
export function computePriceImpact(
  tradeIn: bigint,
  tradeOut: bigint,
  probeIn: bigint,
  probeOut: bigint | null,
): number | null {
  if (tradeIn <= 0n || tradeOut <= 0n) return null;
  if (probeIn <= 0n || probeIn >= tradeIn) return null;
  if (probeOut === null || probeOut <= 0n) return null;

  const spotRate = Number(probeOut) / Number(probeIn);
  const tradeRate = Number(tradeOut) / Number(tradeIn);
  if (!Number.isFinite(spotRate) || !Number.isFinite(tradeRate) || spotRate <= 0) return null;

  const impact = (spotRate - tradeRate) / spotRate;
  if (!Number.isFinite(impact)) return null;
  return Math.max(0, impact);
}

/** The near-spot probe size for a trade: 0.01%, but at least one base unit. */
export function spotProbeInput(tradeIn: bigint): bigint {
  const div = tradeIn / PROBE_DIVISOR;
  return div >= 1n ? div : 1n;
}

