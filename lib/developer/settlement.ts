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

export type SettlementVerdict = "verified" | "reverted" | "pending" | "not_found" | "short" | "unavailable" | "invalid_hash";

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

  let delivered = 0n;
  if (token.native) {
    const tx = await client.getTransaction({ hash: input.txHash as Hash }).catch(() => null);
    const to = (tx?.to ?? receipt.to) as string | null;
    if (to && to.toLowerCase() === input.recipient.toLowerCase() && tx?.value) delivered = tx.value;
  } else {
    delivered = sumTransfersTo(receipt as unknown as { logs: { address: string; topics: string[]; data: string }[] }, token.address, input.recipient);
  }

  const toleranceBps = BigInt(input.toleranceBps ?? 50);
  let min = 0n;
  try {
    min = (parseUnits(expected, token.decimals) * (10_000n - toleranceBps)) / 10_000n;
  } catch {
    min = 0n;
  }
  const deliveredStr = formatUnits(delivered, token.decimals);
  const blockNumber = Number(receipt.blockNumber);

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
