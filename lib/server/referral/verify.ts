import type { Hash } from "viem";
import { getPublicClient } from "@/lib/server/rpc";
import { isEvmAddress } from "@/lib/format";

/**
 * Server-side verification of a referral's qualifying transaction.
 *
 * A referral is only ever qualified from *trusted server-side evidence*. A
 * client-supplied hash, a frontend "success" message, or a screenshot proves
 * nothing. This module reads the transaction and its receipt from the
 * authoritative Monad RPC and checks the explicit qualification rules:
 *
 *   1. The transaction exists.
 *   2. It executed successfully (not reverted, not pending).
 *   3. It is on Monad Mainnet (chain id 143).
 *   4. Its `from` is the referred wallet (the referred user paid).
 *   5. It contains at least one ERC-20 `Transfer` (a real payment, not an
 *      arbitrary call).
 *
 * A provider outage is reported as `unavailable` — distinct from a definitive
 * rejection — so the caller records `pending_verification` and can retry rather
 * than falsely rejecting (or falsely qualifying).
 */

export type VerifyOk = {
  ok: true;
  evidence: {
    chainId: number;
    from: string;
    to: string | null;
    blockNumber: number;
    transferLogs: number;
  };
};

export type VerifyFail = {
  ok: false;
  reason:
    | "not_found"
    | "wrong_chain"
    | "reverted"
    | "pending"
    | "not_payer"
    | "no_transfer"
    | "invalid_hash"
    | "unavailable";
  message: string;
};

export type VerifyResult = VerifyOk | VerifyFail;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export function isValidTxHash(hash: unknown): hash is string {
  return typeof hash === "string" && HASH_RE.test(hash);
}

export type Verifier = (input: { txHash: string; referred: string }) => Promise<VerifyResult>;

/**
 * The production verifier. It only reads; it never signs or broadcasts.
 */
export const verifyQualifyingTransaction: Verifier = async ({ txHash, referred }) => {
  if (!isValidTxHash(txHash)) {
    return { ok: false, reason: "invalid_hash", message: "That isn't a valid transaction hash." };
  }
  if (!isEvmAddress(referred)) {
    return { ok: false, reason: "not_payer", message: "The referred account is invalid." };
  }
  const client = getPublicClient("mainnet");
  let tx: Awaited<ReturnType<typeof client.getTransaction>> | null = null;
  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | null = null;
  try {
    tx = await client.getTransaction({ hash: txHash as Hash });
    receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
  } catch {
    // A missing receipt is either "not found" or a provider problem. Try once
    // more to tell them apart before deciding; never guess.
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
    } catch {
      // Distinguish a genuinely unknown hash from an unreachable RPC by probing
      // the chain id; if that also fails the provider is unavailable.
      try {
        const chainId = await client.getChainId();
        if (chainId !== 143) {
          return { ok: false, reason: "wrong_chain", message: "That transaction is on another chain." };
        }
        return { ok: false, reason: "not_found", message: "That transaction wasn't found on Monad." };
      } catch {
        return {
          ok: false,
          reason: "unavailable",
          message: "We couldn't reach the Monad network to verify the transaction.",
        };
      }
    }
  }

  if (!receipt) {
    return { ok: false, reason: "pending", message: "That transaction hasn't been confirmed yet." };
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "reverted", message: "That transaction reverted on-chain." };
  }

  const from = (tx?.from ?? receipt.from) as string;
  if (!from || from.toLowerCase() !== referred.toLowerCase()) {
    return {
      ok: false,
      reason: "not_payer",
      message: "That transaction wasn't sent by this wallet.",
    };
  }

  const transferLogs = receipt.logs.filter(
    (l) => (l.topics?.[0] ?? "").toLowerCase() === TRANSFER_TOPIC,
  ).length;
  if (transferLogs === 0) {
    return {
      ok: false,
      reason: "no_transfer",
      message: "That transaction isn't a token payment.",
    };
  }

  return {
    ok: true,
    evidence: {
      chainId: 143,
      from: from.toLowerCase(),
      to: (tx?.to as string | null) ?? null,
      blockNumber: Number(receipt.blockNumber),
      transferLogs,
    },
  };
};
