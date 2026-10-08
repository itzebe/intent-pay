/**
 * Pure ERC-20 gas-cost math (client- and server-safe).
 *
 * Lives outside `lib/server/paymaster` so the *same* formula runs when the
 * browser computes the bounded paymaster allowance and when the server prices a
 * gas token. No network, no secrets — only integer arithmetic on provider data.
 */

/** Accept a decimal integer, a 0x-hex quantity, or a bigint. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return 0n;
    return s.startsWith("0x") ? BigInt(s) : BigInt(s);
  }
  return 0n;
}

/**
 * Total UserOperation gas from the operation's own gas fields. Used only for an
 * *estimate*; the authoritative bound is enforced by the paymaster's payload.
 */
export function estimateUserOpGas(userOperation: Record<string, unknown>): bigint {
  const call = toBigInt(userOperation.callGasLimit);
  const verify = toBigInt(userOperation.verificationGasLimit);
  const pre = toBigInt(userOperation.preVerificationGas);
  const postOp = toBigInt(userOperation.paymasterPostOpGasLimit);
  const paymasterVerify = toBigInt(userOperation.paymasterVerificationGasLimit);
  const total = call + verify + pre + postOp + paymasterVerify;
  // Report gas units; the fee currency conversion is applied in `estimateTokenCost`.
  return total > 0n ? total : 0n;
}

/**
 * Token cost of `gasUnits` at `maxFeePerGas`, converted through the paymaster's
 * oracle exchange rate.
 *
 * Pimlico encodes `exchangeRate` as (token base units per native base unit)
 * scaled by 1e18, matching `maxCostInToken = (gas * maxFeePerGas * exchangeRate)
 * / 1e18` from their docs. We mirror that formula exactly rather than inventing
 * a rate. A zero/absent rate yields 0 (unknown), never a fabricated number.
 */
export function estimateTokenCost(gasUnits: bigint, exchangeRate: bigint, maxFeePerGas?: bigint): bigint {
  if (gasUnits <= 0n || exchangeRate <= 0n) return 0n;
  const fee = maxFeePerGas && maxFeePerGas > 0n ? maxFeePerGas : 0n;
  if (fee === 0n) {
    // Without a fee-per-gas we cannot convert; the paymaster payload remains the
    // authoritative cost. Return 0 so callers show "≈" rather than a guess.
    return 0n;
  }
  return (gasUnits * fee * exchangeRate) / 10n ** 18n;
}

/**
 * The exact token amount the paymaster needs approval for, matching Pimlico's
 * published formula:
 *
 *   maxCostInToken = ((userOperationMaxGas + postOpGas) * maxFeePerGas * exchangeRate) / 1e18
 *
 * where `userOperationMaxGas` is call + verification + preVerification +
 * paymasterVerification + paymasterPostOp gas, and `postOpGas` is the provider's
 * extra postOp overhead. Omitting `postOpGas` under-approves and the postOp
 * `transferFrom` reverts.
 */
export function maxCostInToken(input: {
  userOperationMaxGas: bigint;
  postOpGas: bigint;
  maxFeePerGas: bigint;
  exchangeRate: bigint;
}): bigint {
  const gas = input.userOperationMaxGas + input.postOpGas;
  return estimateTokenCost(gas, input.exchangeRate, input.maxFeePerGas);
}

/** Decimal formatting for a base-unit token amount. */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
