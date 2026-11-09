import type { Address, Hex, PublicClient } from "viem";
import {
  SEND_GAS_LIMIT_HEADROOM_DEN,
  SEND_GAS_LIMIT_HEADROOM_NUM,
} from "@/lib/domain/gasReserve";

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
 * fetch: `gas`, a fee, and `nonce`. The wallet is then asked only to approve,
 * sign and broadcast — it has nothing left to read from its own node.
 *
 * The fee is sent as the **legacy `gasPrice`**, derived from the live EIP-1559
 * `maxFeePerGas` cap, because Trust Wallet's dApp transaction contract is legacy
 * (it reads `gasPrice` and ignores the EIP-1559 fields). Only one fee model is
 * ever emitted — a transaction carrying both `gasPrice` and `maxFeePerGas` is
 * rejected as a conflict by many wallets and nodes.
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
  /**
   * Legacy fee field. Trust Wallet's dApp transaction contract is legacy: it
   * reads `gasPrice` and ignores `maxFeePerGas`/`maxPriorityFeePerGas`. When set,
   * `toRpcFields` sends this **instead of** the EIP-1559 pair (a transaction that
   * carries both is rejected by many wallets and nodes).
   */
  gasPrice?: bigint;
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
 *
 * The constants live in `lib/domain/gasReserve.ts` (the native-reserve rule) so
 * the reserve the readiness gate checks and the limit this path sends cannot
 * drift: both must describe the SAME limit.
 */
const GAS_BUFFER_NUM = SEND_GAS_LIMIT_HEADROOM_NUM;
const GAS_BUFFER_DEN = SEND_GAS_LIMIT_HEADROOM_DEN;

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
 * estimate cannot be read. The nonce is always read (fresh, per call): a wallet
 * handed a call without one must fetch it itself, and a wallet whose own node is
 * unreachable — Trust Wallet's in-app browser proxying to `monad.twnodes.com` —
 * fails *after* the user has authorised, which is exactly the reported
 * post-PIN "Transaction error". A sequential multi-call plan re-reads it before
 * each send, so the sequence cannot reorder.
 */
export async function prepareTxFields(
  client: PublicClient,
  call: PreparedCall,
  opts: { account: Address; fallbackGas?: bigint },
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
    attempt(() => client.getTransactionCount({ address: opts.account, blockTag: "pending" })),
  ]);

  const prep: TxPreparation = {};

  if (gasRes.status === "fulfilled") {
    prep.gas = gasLimitWithBuffer(gasRes.value);
  } else if (opts.fallbackGas && opts.fallbackGas > 0n) {
    prep.gas = opts.fallbackGas;
  }

  if (feesRes.status === "fulfilled") {
    const fees = feesRes.value;
    // Trust Wallet's dApp transaction contract is LEGACY: its own open-source
    // dApp layer (iOS `SendTransaction.swift` / `DappAction.makeUnconfirmedTransaction`,
    // Android `Web3View` `processTransaction`) decodes `gasPrice` and ignores
    // `maxFeePerGas`/`maxPriorityFeePerGas`, and wallet-core's signer defaults to
    // `tx_mode = Legacy`, whose only fee field is `gasPrice`. Sending the EIP-1559
    // pair alone left the wallet's legacy path with no usable fee, and it failed
    // after the user authorised with a bare "Transaction error".
    //
    // `maxFeePerGas` is a valid legacy `gasPrice`: it is the EIP-1559 *cap*
    // (baseFee×1.2 + tip), so it is always ≥ the base fee and cannot be
    // underpriced, and it is exactly the figure the readiness reserve already
    // sizes against (`quoteGasReserveWei`), so the balance gate and the fee the
    // wallet signs agree. Never hardcoded, never a fallback.
    //
    // Only ONE fee model is emitted: a transaction carrying both `gasPrice` and
    // `maxFeePerGas` is rejected as a conflict by many wallets and nodes, so
    // `toRpcFields` sends the legacy field instead of the EIP-1559 pair.
    if (fees.maxFeePerGas && fees.maxFeePerGas > 0n) prep.gasPrice = fees.maxFeePerGas;
  }

  if (nonceRes.status === "fulfilled") {
    prep.nonce = BigInt(nonceRes.value);
  }

  return prep;
}

/** Hex-encode the prepared fields, omitting any that are absent or non-positive. */
export function toRpcFields(prep: TxPreparation): Record<string, string> {
  const out: Record<string, string> = {};
  if (prep.gas && prep.gas > 0n) out.gas = "0x" + prep.gas.toString(16);
  // Exactly one fee model is emitted. The legacy `gasPrice` (what Trust Wallet's
  // dApp contract reads) takes precedence; the EIP-1559 pair is sent only when no
  // legacy fee is available, so a request never carries both — wallets and nodes
  // reject a transaction that sets `gasPrice` and `maxFeePerGas` together.
  if (prep.gasPrice && prep.gasPrice > 0n) {
    out.gasPrice = "0x" + prep.gasPrice.toString(16);
  } else {
    if (prep.maxFeePerGas && prep.maxFeePerGas > 0n) {
      out.maxFeePerGas = "0x" + prep.maxFeePerGas.toString(16);
    }
    if (prep.maxPriorityFeePerGas && prep.maxPriorityFeePerGas > 0n) {
      out.maxPriorityFeePerGas = "0x" + prep.maxPriorityFeePerGas.toString(16);
    }
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
