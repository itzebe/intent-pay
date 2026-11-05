import { decodeEventLog, type Hash, type PublicClient } from "viem";
import { getPublicClient } from "@/lib/server/rpc";
import { getToken, getTokenByAddress, type TokenConfig } from "@/lib/config/tokens";
import { ERC20_ABI } from "@/lib/execution/abis";
import { formatUnits, parseUnits } from "@/lib/domain/math";
import { isValidTxHash } from "@/lib/server/referral/verify";

/**
 * Independent, server-side settlement verification for the developer API.
 *
 * A `CONFIRMED` transaction is **not** a verified payment. This module reads the
 * authoritative Monad receipt itself and proves the recipient actually received
 * the requested asset — the same evidence standard the browser's `verifyDelivery`
 * uses, but with no trust in the caller:
 *
 *   - ERC-20: sum the receive token's `Transfer` events to the recipient, from
 *     the confirmed receipt (not from any caller-supplied log).
 *   - Native MON: the direct transfer value to the recipient.
 *
 * A failure to reach the chain is `unavailable` — never a false negative — and a
 * reverted transaction is `reverted`, never "pending". The delivered amount is
 * compared against the intent's requested amount minus the plan's slippage
 * tolerance; a shortfall is reported honestly as `short`.
 */

export type SettlementVerdict =
  | "verified"
  | "reverted"
  | "pending"
  | "not_found"
  | "short"
  | "unavailable"
  | "invalid_hash"
  /** The transaction predates the order — it cannot be this order's payment. */
  | "historical"
  /** The receipt is mined but not yet past the finality policy. */
  | "unconfirmed";

export type SettlementCheck = {
  verdict: SettlementVerdict;
  /** Decimal string actually delivered to the recipient (when measurable). */
  delivered: string | null;
  /** Decimal string the intent requested. */
  expected: string;
  /** The receipt's block number, when a receipt was read. */
  blockNumber: number | null;
  /** The chain id the transaction is on. */
  chainId: number | null;
  message: string;
};

/**
 * How much clock skew to tolerate when comparing a receipt's block time to the
 * order's creation time. The intent's `createdAt` is our server clock; the block
 * time is the chain's. A genuine payment made seconds after the order was created
 * can appear marginally earlier, so a small tolerance avoids a false `historical`
 * without admitting a transfer from meaningfully before the order existed.
 */
export const ORDER_BINDING_SKEW_MS = 120_000;

/**
 * Confirmations required before a receipt is trusted as final. Mirrors the
 * browser execution's `FINALITY_CONFIRMATIONS` (2, see `lib/execution/execute.ts`)
 * but is declared here rather than imported: that module is `"use client"`, and
 * importing it from a server route would break at runtime.
 */
export const MIN_FINALITY_CONFIRMATIONS = 2;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function sumTransfersTo(receipt: { logs: { address: string; topics: string[]; data: string }[] }, tokenAddress: string, recipient: string): bigint {
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
    if ((log.topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      const to = (decoded.args as Record<string, unknown>)?.to as string | undefined;
      const value = (decoded.args as Record<string, unknown>)?.value as bigint | undefined;
      if (to && value !== undefined && to.toLowerCase() === recipient.toLowerCase()) total += value;
    } catch {
      /* not a decodable Transfer — skip */
    }
  }
  return total;
}

/**
 * Resolve the receive token for a verification: prefer the contract address the
 * intent recorded (authoritative), fall back to the symbol.
 */
export function receiveTokenFor(receiveTokenAddress: string, receiveToken: string): TokenConfig | undefined {
  return getTokenByAddress(receiveTokenAddress) ?? getToken(receiveToken);
}

/**
 * The settlement tolerance (bps) for an intent's amount mode.
 *
 * `recipient_receives` is exact-output: the plan's on-chain `amountOutMinimum`
 * already guarantees the recipient gets at least the requested amount, so the
 * verifier demands it exactly (0 bps) — an under-delivery is a `short` failure,
 * not a tolerable rounding. `i_spend` fixes what the sender spends, so the
 * recipient's output can vary with the route; a small tolerance reflects that.
 */
export function settlementToleranceBps(amountMode: string): number {
  return amountMode === "recipient_receives" ? 0 : 50;
}

export async function verifySettlement(input: {
  txHash: string;
  recipient: string;
  receiveTokenAddress: string;
  receiveToken: string;
  expectedAmount: string;
  /** Slippage tolerance (bps) the payment was authorized with. */
  toleranceBps?: number;
  /**
   * The client to read the chain with. Defaults to the shared Monad public
   * client; injectable so the verification rule can be tested against a fixed
   * receipt without a network (mirrors `verifyDelivery`).
   */
  client?: PublicClient;
  /**
   * The order's creation time (unix ms). When set, a transaction whose receipt
   * block is older than this (minus a small skew) is `historical` — it cannot be
   * this order's payment, so a matching-but-old transfer is refused.
   */
  notBeforeMs?: number;
  /**
   * The number of confirmations the receipt must have before it is trusted as
   * final. Defaults to `MIN_FINALITY_CONFIRMATIONS`; a receipt that is mined but
   * not yet this deep is `unconfirmed`, never `verified`.
   */
  minConfirmations?: number;
  /**
   * The exact destination the transfer must reach. When omitted it defaults to
   * `recipient`. A checkout-bound order passes its **unique derived address**
   * here, so a transfer that reached any other destination (including the
   * merchant's shared recipient) cannot settle it.
   */
  destination?: string;
}): Promise<SettlementCheck> {
  const expected = input.expectedAmount;
  if (!isValidTxHash(input.txHash)) {
    return { verdict: "invalid_hash", delivered: null, expected, blockNumber: null, chainId: null, message: "That isn't a valid transaction hash." };
  }

  const token = receiveTokenFor(input.receiveTokenAddress, input.receiveToken);
  if (!token) {
    return { verdict: "unavailable", delivered: null, expected, blockNumber: null, chainId: null, message: "The receive asset is unknown, so settlement cannot be verified." };
  }

  const client = input.client ?? getPublicClient("mainnet");
  let chainId: number | null = null;
  try {
    chainId = await client.getChainId();
    if (chainId !== 143) {
      return { verdict: "unavailable", delivered: null, expected, blockNumber: null, chainId, message: "The RPC is not on Monad Mainnet." };
    }
  } catch {
    return { verdict: "unavailable", delivered: null, expected, blockNumber: null, chainId: null, message: "We couldn't reach the Monad network to verify the transaction." };
  }

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: input.txHash as Hash });
  } catch {
    // Distinguish "not found" from a provider problem with one more probe.
    try {
      await client.getChainId();
      return { verdict: "not_found", delivered: null, expected, blockNumber: null, chainId, message: "That transaction wasn't found on Monad." };
    } catch {
      return { verdict: "unavailable", delivered: null, expected, blockNumber: null, chainId, message: "We couldn't reach the Monad network to verify the transaction." };
    }
  }

  if (!receipt) {
    return { verdict: "pending", delivered: null, expected, blockNumber: null, chainId, message: "That transaction hasn't been confirmed yet." };
  }
  if (receipt.status !== "success") {
    return { verdict: "reverted", delivered: null, expected, blockNumber: Number(receipt.blockNumber), chainId, message: "That transaction reverted on-chain." };
  }

  const receiptBlock = Number(receipt.blockNumber);

  // Finality: a mined receipt is not final until it is buried under the policy's
  // confirmations. Read the head; if it cannot be read we cannot judge depth, so
  // the honest verdict is `unavailable` (retry), never a false confirmation.
  const minConfirmations = BigInt(Math.max(0, input.minConfirmations ?? MIN_FINALITY_CONFIRMATIONS));
  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch {
    return { verdict: "unavailable", delivered: null, expected, blockNumber: receiptBlock, chainId, message: "We couldn't read the Monad chain height to confirm finality." };
  }
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  if (confirmations < minConfirmations) {
    return {
      verdict: "unconfirmed",
      delivered: null,
      expected,
      blockNumber: receiptBlock,
      chainId,
      message: `That transaction is mined but only ${confirmations.toString()} of ${minConfirmations.toString()} required confirmations deep.`,
    };
  }

  // Order binding: a transfer that predates the order cannot be its payment. The
  // receipt's block time is the chain's authority for when the transfer happened.
  if (input.notBeforeMs !== undefined) {
    let blockTimeMs: number | null = null;
    try {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      blockTimeMs = Number(block.timestamp) * 1000;
    } catch {
      blockTimeMs = null;
    }
    if (blockTimeMs === null) {
      return { verdict: "unavailable", delivered: null, expected, blockNumber: receiptBlock, chainId, message: "We couldn't read the transaction's block to confirm it belongs to this order." };
    }
    if (blockTimeMs + ORDER_BINDING_SKEW_MS < input.notBeforeMs) {
      return {
        verdict: "historical",
        delivered: null,
        expected,
        blockNumber: receiptBlock,
        chainId,
        message: "That transaction predates this order, so it cannot be its payment.",
      };
    }
  }

  let delivered = 0n;
  // The destination is where funds must land. It defaults to the recipient, but a
  // checkout-bound order passes its unique derived address, so a transfer to any
  // other destination (the merchant's shared recipient included) is not counted
  // and cannot settle this order.
  const destination = (input.destination ?? input.recipient).toLowerCase();
  if (token.native) {
    const tx = await client.getTransaction({ hash: input.txHash as Hash }).catch(() => null);
    const to = (tx?.to ?? receipt.to) as string | null;
    if (to && to.toLowerCase() === destination && tx?.value) delivered = tx.value;
  } else {
    delivered = sumTransfersTo(receipt as unknown as { logs: { address: string; topics: string[]; data: string }[] }, token.address, destination);
  }

  const toleranceBps = BigInt(input.toleranceBps ?? 50);
  let min = 0n;
  try {
    min = (parseUnits(expected, token.decimals) * (10_000n - toleranceBps)) / 10_000n;
  } catch {
    min = 0n;
  }
  const deliveredStr = formatUnits(delivered, token.decimals);
  const blockNumber = receiptBlock;

  if (delivered >= min && delivered > 0n) {
    return { verdict: "verified", delivered: deliveredStr, expected, blockNumber, chainId, message: "The recipient received the requested amount." };
  }
  return {
    verdict: "short",
    delivered: deliveredStr,
    expected,
    blockNumber,
    chainId,
    message: delivered === 0n ? "No matching transfer to the recipient was found." : "The recipient received less than intended.",
  };
}
