/**
 * Native MON gas reserve — the MON a payment must keep aside to pay its own
 * network fee when the payment *spends* native MON.
 *
 * This replaces a flat 0.01 MON reserve that was applied to every native
 * payment. On Monad the fee is gas-limit × gas-price, so a native MON transfer
 * (exactly 21,000 gas at the ~100 gwei floor ≈ 0.0021 MON, per the Monad docs)
 * was being charged a flat 0.01 MON — about 4–5× the real cost — which rejected
 * a small native payment whose balance sat between amount + real gas and
 * amount + 0.01 MON.
 *
 * Monad charges the gas *limit* you set (not the gas actually used), so a
 * fixed gas limit gives a safe upper bound on the fee:
 *   - native MON transfer: 21,000 gas (protocol-defined; Monad docs)
 *   - ERC-20 transfer / swap / approve: generous per-step bounds (see
 *     `lib/execution/plan.ts` `STEP_GAS_UNITS`), summed across the plan.
 *
 * The reserve is `signedGasLimit(planGasUnits) × maxFeePerGas`, where
 * `signedGasLimit` adds the submission headroom (Monad charges the limit the
 * wallet signs, not the bare plan estimate) and `maxFeePerGas` is the higher of
 * 1.2× the live gas price and the Monad base-fee floor + headroom. It is a
 * bounded upper bound, never an arbitrary amount, and never widened to force a
 * transaction through.
 */

import type { Quote } from "./intent";

/** Conservative gas units when no live estimate is available. */
export const FALLBACK_GAS_UNITS = 350_000n;

/**
 * Fallback max fee per gas: the Monad base-fee floor (100 gwei) plus headroom,
 * so a reserve is always at least the network's minimum viable fee.
 */
export const FALLBACK_MAX_FEE_PER_GAS_WEI = 110_000_000_000n;

/** Headroom applied to a live gas price so the reserve covers a small rise. */
const GAS_PRICE_BUFFER_NUM = 120n;
const GAS_PRICE_BUFFER_DEN = 100n;

/**
 * Headroom applied to a plan's gas units to obtain the gas **limit the wallet is
 * asked to sign**.
 *
 * Monad charges the gas *limit*, and the submission path buffers the node's
 * estimate by 20% (`lib/execution/prepareTx.ts`) so a swap that ticks between
 * estimate and signature still fits. The reserve must therefore be sized against
 * that *sent* limit — not the bare plan estimate — or a native MON payment whose
 * balance covers `amount + estimate×maxFee` but not `amount + 1.2×estimate×maxFee`
 * passes Review and is then rejected by the node with `insufficient funds for
 * gas`. The two sites share these constants so they cannot drift.
 */
export const SEND_GAS_LIMIT_HEADROOM_NUM = 120n;
export const SEND_GAS_LIMIT_HEADROOM_DEN = 100n;

/**
 * The gas limit a plan step of `gasUnits` will actually be signed with: the plan
 * bound plus the submission headroom. The reserve's gas-limit basis must be this
 * figure, because Monad charges the limit, not the amount used. A non-positive
 * input is returned unchanged (never invent a limit).
 */
export function signedGasLimit(gasUnits: bigint): bigint {
  if (gasUnits <= 0n) return gasUnits;
  return (gasUnits * SEND_GAS_LIMIT_HEADROOM_NUM) / SEND_GAS_LIMIT_HEADROOM_DEN;
}

/**
 * The max fee per gas a reserve should be sized against. A live gas price is
 * buffered by 20%; an absent/zero price falls back to the Monad floor.
 */
export function deriveMaxFeePerGasWei(gasPriceWei?: bigint): bigint {
  if (!gasPriceWei || gasPriceWei <= 0n) return FALLBACK_MAX_FEE_PER_GAS_WEI;
  const buffered = (gasPriceWei * GAS_PRICE_BUFFER_NUM) / GAS_PRICE_BUFFER_DEN;
  return buffered > FALLBACK_MAX_FEE_PER_GAS_WEI ? buffered : FALLBACK_MAX_FEE_PER_GAS_WEI;
}

/**
 * The MON (in wei) a payment must reserve for gas, derived from the quote's own
 * gas-limit × max-fee. Unknown inputs fall back to a bounded conservative figure
 * (never zero — a native payment must always keep *some* gas aside).
 */
export function gasReserveWei(gasLimit?: bigint, gasPriceWei?: bigint): bigint {
  const units = gasLimit && gasLimit > 0n ? gasLimit : FALLBACK_GAS_UNITS;
  // The reserve must cover the fee of the limit the wallet is *actually asked to
  // sign*, which carries the submission headroom — Monad charges the limit.
  return signedGasLimit(units) * deriveMaxFeePerGasWei(gasPriceWei);
}

/** Convenience: the reserve for a quote's own gas parameters. */
export function quoteGasReserveWei(quote: Pick<Quote, "gasLimit" | "gasPriceWei"> | null | undefined): bigint {
  return gasReserveWei(quote?.gasLimit, quote?.gasPriceWei);
}
