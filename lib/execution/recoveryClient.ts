"use client";

import { createPublicClient, http, type PublicClient } from "viem";
import { NETWORKS, browserRpcUrls } from "@/lib/config/chains";
import { ENDPOINT_TIMEOUT_MS } from "@/lib/rpc/receiptFailover";
import { recoverSubmission, type RecoveryEndpointReads, type RecoveryResult, type AttemptIdentity } from "@/lib/domain/recovery";

/**
 * Build the recovery reads from the application's own HTTPS RPC endpoints.
 *
 * Recovery must never depend on the wallet's provider (its node is exactly what
 * failed). Every read here goes through Intent Pay's own clients, and each
 * configured endpoint is queried **independently** so a node that has not
 * indexed a receipt, or whose mempool holds a transaction another node does not,
 * cannot alone decide the outcome. The pure engine
 * (`lib/domain/recovery.ts`) combines them.
 *
 * One client per endpoint — deliberately not the failover client: failover hides
 * *which* node answered, and recovery needs to know when nodes disagree.
 */
function endpointReads(account: `0x${string}`, network: "mainnet"): RecoveryEndpointReads[] {
  const net = NETWORKS[network];
  return browserRpcUrls(network).map((url, index) => {
    const client: PublicClient = createPublicClient({
      chain: net.chain,
      transport: http(url, { timeout: ENDPOINT_TIMEOUT_MS }),
    });
    return {
      // A short, non-sensitive label: enough to tell nodes apart in diagnostics,
      // never the full URL (which could carry a key in its path).
      label: `rpc${index}`,
      getTransactionReceipt: async (hash) => {
        const r = await client.getTransactionReceipt({ hash });
        return r ? { status: r.status } : null;
      },
      getTransaction: async (hash) => {
        const tx = await client.getTransaction({ hash });
        if (!tx) return null;
        return { from: tx.from, to: tx.to, nonce: tx.nonce, value: tx.value, input: tx.input };
      },
      getTransactionCount: async (blockTag) =>
        BigInt(await client.getTransactionCount({ address: account, blockTag })),
    } satisfies RecoveryEndpointReads;
  });
}

/**
 * Run an evidence-based recovery pass through Intent Pay's own RPC endpoints.
 * Read-only: it never signs, never broadcasts, and never resubmits.
 */
export async function recoverWithAppRpc(input: {
  network?: "mainnet";
  attempt: AttemptIdentity;
  hashes: `0x${string}`[];
  rejected?: boolean;
  preSubmissionFailure?: boolean;
}): Promise<RecoveryResult> {
  const network = input.network ?? "mainnet";
  return recoverSubmission({
    reads: { account: input.attempt.from, endpoints: endpointReads(input.attempt.from, network) },
    attempt: input.attempt,
    hashes: input.hashes,
    rejected: input.rejected,
    preSubmissionFailure: input.preSubmissionFailure,
  });
}
