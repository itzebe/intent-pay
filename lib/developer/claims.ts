import { getStore } from "@/lib/store";
import type { ApiTxClaimRecord } from "@/lib/store/types";
import { MONAD_CHAIN_ID } from "./engine";

/**
 * Durable, concurrency-safe transaction claims — the replay guard.
 *
 * A single on-chain transaction may satisfy **at most one** payment intent. The
 * claim's identity is `(chainId, txHash)`, and it is stored as the primary key of
 * `apiTxClaims`, so the database itself enforces "claimed once": two concurrent
 * verifications of the same hash cannot both insert, and a losing insert is told
 * the hash is already consumed.
 *
 * The claim is taken **only at verification**, after the chain has proven the
 * recipient was paid. That ordering matters: an unproven hash (a wrong token, a
 * reverted tx, a shortfall, a hash from another chain) never becomes a claim, so
 * an attacker cannot burn a victim's real transaction hash by submitting it
 * against a throwaway order. Replay is prevented without introducing a griefing
 * vector.
 */

/** Normalise a hash for identity comparison (lower-case, trimmed). */
function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase();
}

export type ClaimOutcome =
  | { ok: true; claim: ApiTxClaimRecord }
  /** The hash is already claimed by a *different* intent — a replay. */
  | { ok: false; code: "replay_detected"; claimedBy: ApiTxClaimRecord };

/**
 * Claim a transaction for an intent, atomically.
 *
 * Idempotent for the same intent (a retried verify returns its own claim), and a
 * hard refusal for any other intent. The insert is the race: the primary key
 * `(chainId, txHash)` makes exactly one of two concurrent claims win.
 */
export async function claimTransaction(input: {
  chainId: number;
  txHash: string;
  intentId: string;
  developerId: string;
  blockNumber?: number | null;
  delivered?: string | null;
  now?: number;
}): Promise<ClaimOutcome> {
  const store = getStore();
  const chainId = input.chainId;
  const txHash = normalizeHash(input.txHash);
  const now = input.now ?? Date.now();

  const existing = await store.findOne("apiTxClaims", { chainId, txHash });
  if (existing) {
    if (existing.intentId === input.intentId) return { ok: true, claim: existing };
    return { ok: false, code: "replay_detected", claimedBy: existing };
  }

  const claim: ApiTxClaimRecord = {
    chainId,
    txHash,
    intentId: input.intentId,
    developerId: input.developerId,
    blockNumber: input.blockNumber ?? null,
    delivered: input.delivered ?? null,
    claimedAt: now,
  };
  try {
    await store.insert("apiTxClaims", claim);
    return { ok: true, claim };
  } catch {
    // Lost the race — read the winner and decide idempotent-vs-replay.
    const winner = await store.findOne("apiTxClaims", { chainId, txHash });
    if (winner && winner.intentId === input.intentId) return { ok: true, claim: winner };
    return {
      ok: false,
      code: "replay_detected",
      claimedBy:
        winner ??
        ({ chainId, txHash, intentId: "unknown", developerId: "unknown", blockNumber: null, delivered: null, claimedAt: now } as ApiTxClaimRecord),
    };
  }
}

/** Read the claim on a transaction, if any. */
export async function txClaim(chainId: number, txHash: string): Promise<ApiTxClaimRecord | null> {
  return (await getStore().findOne("apiTxClaims", { chainId, txHash: normalizeHash(txHash) })) ?? null;
}

/** The claim an intent holds, if any (one payment consumes at most one hash). */
export async function intentClaim(intentId: string): Promise<ApiTxClaimRecord | null> {
  return (await getStore().findOne("apiTxClaims", { intentId })) ?? null;
}

/**
 * True when the hash is already consumed by an intent other than `intentId`.
 * A read-only check for paths that must report a replay without taking a claim.
 */
export async function claimedByOther(txHash: string, intentId: string, chainId = MONAD_CHAIN_ID): Promise<ApiTxClaimRecord | null> {
  const claim = await txClaim(chainId, txHash);
  if (claim && claim.intentId !== intentId) return claim;
  return null;
}
