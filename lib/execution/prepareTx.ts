import type { Address, Hex, PublicClient } from "viem";

/**
 * Application-owned transaction preparation.
 *
 * Intent Pay reads the chain through its own HTTPS Monad RPC, but until now it
 * handed the wallet a bare `{from,to,data,value,chainId}` and let the wallet
 * fill in gas, fees and nonce. A wallet that does that by talking to *its own*
 * node — Trust Wallet's in-app browser answers non-native methods by proxying to
 * `monad.twnodes.com` — fails when that node is unreachable, and the customer
 * sees `Failed to connect to http://monad.twnodes.com/` after Confirm and Send.
 *
 * This module lets the app supply the fields a wallet would otherwise have to
 * fetch: `gas`, `maxFeePerGas`, `maxPriorityFeePerGas` and (optionally) `nonce`.
 * The wallet is then asked only to approve, sign and broadcast.
 *
 * Every read here is best-effort and total: a field whose read fails is
 * **omitted**, never fabricated, so a wallet that genuinely needs to estimate
 * still can. Nothing here changes the calldata, the sender, the recipient or the
 * on-chain output bound — it only fills in the envelope.
 *
 * Monad is EIP-1559 and charges the gas **limit** (not the gas used), so the gas
 * figure is kept tight: a small buffer over the node's own estimate, and the
 * plan's own per-step bound as a fallback when the estimate is unavailable.
 */

export type TxPreparation = {
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: bigint;
};

/** A call the app has already encoded. */
export type PreparedCall = { to: Address; data?: Hex; value?: bigint };

/**
 * Gas headroom over the node's estimate (20%).
 *
 * Monad charges the gas *limit*, so this buffer is a real (tiny) cost, not free
 * headroom: a native transfer's 21,000 becomes 25,200. It is kept because the
 * estimate is taken a moment before the wallet signs and a swap can need a
 * little more if the route ticks — and the wallet cannot re-estimate when its own
 * node is unreachable. 20% matches the existing `coversGas` reserve, so the
 * signed limit and the readiness gate stay consistent.
 */
const GAS_BUFFER_NUM = 120n;
const GAS_BUFFER_DEN = 100n;

/**
 * A tight, bounded gas limit for an estimated transaction. Zero/unknown stays
 * zero (the caller then falls back to its own bound) — we never invent a limit.
 */
export function gasLimitWithBuffer(estimate: bigint): bigint {
  if (estimate <= 0n) return estimate;
  return (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
}

/**
 * Prepare the envelope fields for one call using the app's own RPC.
 *
 * `fallbackGas` is the plan's own per-step bound, used only when the live
 * estimate cannot be read. `includeNonce` is set for a sequential multi-call
 * payment, where a single fixed nonce removes any chance of a nonce race while
 * still being re-read fresh before each send.
 */
export async function prepareTxFields(
  client: PublicClient,
  call: PreparedCall,
  opts: { account: Address; fallbackGas?: bigint; includeNonce?: boolean },
): Promise<TxPreparation> {
  // The three reads are independent; run them together so a slow node adds one
  // round-trip, not three, to the time before the wallet's prompt appears. Each
  // is wrapped so a missing method or a synchronous throw becomes a rejection
  // this function absorbs — preparing the envelope must never be the reason a
  // payment cannot proceed.
  const attempt = <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  };

  const [gasRes, feesRes, nonceRes] = await Promise.allSettled([
    attempt(() =>
      client.estimateGas({
        account: opts.account,
        to: call.to,
        data: call.data,
        value: call.value,
      }),
    ),
    attempt(() => client.estimateFeesPerGas()),
    opts.includeNonce
      ? attempt(() => client.getTransactionCount({ address: opts.account, blockTag: "pending" }))
      : Promise.resolve(null),
  ]);

  const prep: TxPreparation = {};

  if (gasRes.status === "fulfilled") {
    prep.gas = gasLimitWithBuffer(gasRes.value);
  } else if (opts.fallbackGas && opts.fallbackGas > 0n) {
    prep.gas = opts.fallbackGas;
  }

  if (feesRes.status === "fulfilled") {
    const fees = feesRes.value;
    if (fees.maxFeePerGas && fees.maxFeePerGas > 0n) prep.maxFeePerGas = fees.maxFeePerGas;
    if (fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n) {
      prep.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    }
  }

  if (nonceRes.status === "fulfilled" && nonceRes.value !== null) {
    prep.nonce = BigInt(nonceRes.value);
  }

  return prep;
}

/** Hex-encode the prepared fields, omitting any that are absent or non-positive. */
export function toRpcFields(prep: TxPreparation): Record<string, string> {
  const out: Record<string, string> = {};
  if (prep.gas && prep.gas > 0n) out.gas = "0x" + prep.gas.toString(16);
  if (prep.maxFeePerGas && prep.maxFeePerGas > 0n) {
    out.maxFeePerGas = "0x" + prep.maxFeePerGas.toString(16);
  }
  if (prep.maxPriorityFeePerGas && prep.maxPriorityFeePerGas > 0n) {
    out.maxPriorityFeePerGas = "0x" + prep.maxPriorityFeePerGas.toString(16);
  }
  if (prep.nonce !== undefined && prep.nonce >= 0n) out.nonce = "0x" + prep.nonce.toString(16);
  return out;
}

/**
 * The single builder for an `eth_sendTransaction` param object, shared by the
 * composer (`sendTransactionViaWallet`) and the hosted checkout so both send the
 * wallet the exact same shape. An empty `data` is omitted rather than sent as
 * `0x`, so a plain native transfer is unambiguous.
 */
export function buildSendParams(args: {
  from: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  chainId: `0x${string}`;
  prepared?: TxPreparation;
}): Record<string, unknown> {
  return {
    from: args.from,
    to: args.to,
    ...(args.data && args.data !== "0x" ? { data: args.data } : {}),
    ...(args.value !== undefined ? { value: "0x" + args.value.toString(16) } : {}),
    chainId: args.chainId,
    ...toRpcFields(args.prepared ?? {}),
  };
}
