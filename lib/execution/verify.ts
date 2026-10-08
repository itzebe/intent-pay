import { decodeEventLog, type Address, type Hash, type PublicClient } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import type { TokenConfig } from "@/lib/config/tokens";
import { formatUnits, parseUnits } from "@/lib/domain/math";
import { ERC20_ABI } from "./abis";

/**
 * Delivery verification.
 *
 * A confirmed transaction is not the same thing as a fulfilled payment intent.
 * After the plan's transactions confirm we inspect their receipts and prove the
 * recipient actually received the requested token amount:
 *   - ERC-20 receive token: sum the token's Transfer events to the recipient,
 *   - native MON: sum the value our own delivery step sent to the recipient.
 *
 * If we cannot prove delivery we say so rather than assuming success.
 */
export type DeliveryCheck = {
  verified: boolean;
  /** Decimal string actually delivered to the recipient. */
  delivered: string;
  expected: string;
  /** Why verification could not be proven, when it could not. */
  reason?: string;
};

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

function sumTransfersTo(
  _client: PublicClient,
  receipt: { logs: { address: string; topics: string[]; data: string }[] },
  tokenAddress: string,
  recipient: string,
): bigint {
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
      const to = (decoded.args as any)?.to as string | undefined;
      const value = (decoded.args as any)?.value as bigint | undefined;
      if (to && value !== undefined && to.toLowerCase() === recipient.toLowerCase()) {
        total += value;
      }
    } catch {
      /* not a decodable Transfer — skip */
    }
  }
  return total;
}

export async function verifyDelivery(
  client: PublicClient,
  hashes: Hash[],
  receiveToken: TokenConfig,
  recipient: string,
  expectedAmount: string,
  toleranceBps = 50n,
): Promise<DeliveryCheck> {
  const expected = parseUnits(expectedAmount, receiveToken.decimals);
  if (hashes.length === 0) {
    return { verified: false, delivered: "0", expected: expectedAmount, reason: "no transaction" };
  }

  let delivered = 0n;
  let sawReceipt = false;
  for (const hash of hashes) {
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch {
      continue;
    }
    if (!receipt || receipt.status !== "success") continue;
    sawReceipt = true;

    if (receiveToken.native) {
      // Our own delivery step pays the recipient directly in MON.
      const to = (receipt as any).to as string | undefined;
      if (to && to.toLowerCase() === recipient.toLowerCase()) {
        const tx = await client.getTransaction({ hash }).catch(() => null);
        if (tx?.value) delivered += tx.value;
      }
    } else {
      delivered += sumTransfersTo(client, receipt as any, receiveToken.address, recipient);
    }
  }

  if (!sawReceipt) {
    return {
      verified: false,
      delivered: "0",
      expected: expectedAmount,
      reason: "no successful receipt found",
    };
  }

  const min = (expected * (10_000n - toleranceBps)) / 10_000n;
  const deliveredStr = formatUnits(delivered, receiveToken.decimals);
  return {
    verified: delivered >= min,
    delivered: deliveredStr,
    expected: expectedAmount,
    reason: delivered >= min ? undefined : "recipient received less than intended",
  };
}

export type { Address, MonadNetwork };

/**
 * Delivery verification from a set of raw logs (a UserOperation's receipt logs).
 *
 * The ERC-20 gas path executes as one UserOperation whose receipt carries the
 * inner call logs. The verification is identical in meaning to the EOA path:
 * sum the receive token's Transfer events to the recipient and compare against
 * the on-chain-bound minimum. The UserOperation's own `success` flag is checked
 * by the caller first — a reverted UserOperation has no delivery.
 */
export function verifyDeliveryFromLogs(
  logs: { address: string; topics: string[]; data: string }[],
  receiveToken: TokenConfig,
  recipient: string,
  expectedAmount: string,
  toleranceBps = 50n,
): DeliveryCheck {
  const expected = parseUnits(expectedAmount, receiveToken.decimals);
  if (!logs.length) {
    return { verified: false, delivered: "0", expected: expectedAmount, reason: "no logs" };
  }
  let delivered = 0n;
  if (!receiveToken.native) {
    delivered = sumTransfersTo(
      null as unknown as PublicClient,
      { logs },
      receiveToken.address,
      recipient,
    );
  } else {
    // Native MON delivered by a UserOperation appears as an inner transfer with
    // no ERC-20 log; we cannot prove it from logs alone.
    return {
      verified: false,
      delivered: "0",
      expected: expectedAmount,
      reason: "native delivery cannot be proven from UserOperation logs",
    };
  }
  const min = (expected * (10_000n - toleranceBps)) / 10_000n;
  const deliveredStr = formatUnits(delivered, receiveToken.decimals);
  return {
    verified: delivered >= min,
    delivered: deliveredStr,
    expected: expectedAmount,
    reason: delivered >= min ? undefined : "recipient received less than intended",
  };
}
