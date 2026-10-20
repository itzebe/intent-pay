import { randomUUID } from "node:crypto";
import { getStore, StoreConflictError } from "@/lib/store";
import type { ReferralRecord, ReferralState } from "@/lib/store/types";
import { generateUniqueCode, normalizeCode } from "@/lib/domain/referralCode";
import { ATTRIBUTION_WINDOW_MS, MAX_ATTRIBUTIONS_PER_REFERRER } from "@/lib/config/referral";
import { isEvmAddress } from "@/lib/format";
import type { Verifier } from "./verify";

/**
 * The referral system: attribution and qualification only — no rewards, no
 * payouts, no fabricated counts.
 *
 * Identity is the wallet address (the only durable identity the app has), and
 * every state transition happens here, on the server, from evidence the server
 * can check. The client can never set a state, assign itself an attribution, or
 * qualify a referral; it can only request an action that this module validates.
 *
 * The lifecycle is explicit:
 *   clicked → attributed → (registered) → activated → pending_verification → qualified
 * with `rejected` as a terminal failure. A click is never a qualified referral.
 *
 * Every function is asynchronous because the store is: the same logic runs
 * unchanged against the in-memory, SQLite and Postgres adapters. Uniqueness is
 * enforced by the database, so a lost race is handled by reading the winner's
 * row, never by overwriting.
 */

export type ReferralErrorCode =
  | "invalid_code"
  | "invalid_address"
  | "self_referral"
  | "already_attributed"
  | "not_attributed"
  | "not_authorized"
  | "window_expired"
  | "duplicate_transaction"
  | "referrer_limit";

export type Result<T> = { ok: true; value: T } | { ok: false; code: ReferralErrorCode; message: string };

function fail(code: ReferralErrorCode, message: string): Result<never> {
  return { ok: false, code, message };
}

/** The code owned by a wallet, if any. */
export async function getCodeFor(owner: string): Promise<string | null> {
  const row = await getStore().findOne("referralCodes", { owner: owner.toLowerCase() });
  return row?.code ?? null;
}

/**
 * Return the wallet's referral code, creating one on first use. The same code is
 * returned on every subsequent call — a code is never regenerated per page load.
 */
export async function getOrCreateCode(owner: string, now = Date.now()): Promise<Result<string>> {
  if (!isEvmAddress(owner)) return fail("invalid_address", "Connect a wallet to get a referral link.");
  const lower = owner.toLowerCase();
  const existing = await getCodeFor(lower);
  if (existing) return { ok: true, value: existing };
  const store = getStore();
  // Draw a candidate and let the UNIQUE constraints settle any race: the insert
  // either succeeds or throws, and the loser reads the winner's row.
  let code = generateUniqueCode(() => false);
  for (let attempt = 0; attempt < 5; attempt++) {
    const collision = await store.findOne("referralCodes", { code });
    if (!collision) break;
    code = generateUniqueCode(() => false);
  }
  try {
    await store.insert("referralCodes", { code, owner: lower, createdAt: now });
    return { ok: true, value: code };
  } catch (err) {
    if (err instanceof StoreConflictError) {
      // Another request created the owner's (or this) code first.
      const winner = await getCodeFor(lower);
      if (winner) return { ok: true, value: winner };
    }
    throw err;
  }
}

/** Record a click on a referral link (deduplicated per code+fingerprint+day). */
export async function recordClick(
  input: { code: string; fingerprint: string; now?: number },
): Promise<Result<{ code: string; deduped: boolean }>> {
  const now = input.now ?? Date.now();
  const code = normalizeCode(input.code);
  if (!code) return fail("invalid_code", "That referral code isn't valid.");
  const ownerRow = await getStore().findOne("referralCodes", { code });
  if (!ownerRow) return fail("invalid_code", "That referral code isn't valid.");
  const day = new Date(now).toISOString().slice(0, 10);
  const clickKey = `${code}:${input.fingerprint}:${day}`;
  const existing = await getStore().findOne("referrals", { clickKey });
  if (existing) return { ok: true, value: { code, deduped: true } };
  const record: ReferralRecord = {
    id: randomUUID(),
    referrer: ownerRow.owner,
    referred: null,
    code,
    state: "clicked",
    createdAt: now,
    updatedAt: now,
    attributedAt: null,
    qualifiedAt: null,
    qualifiedTxHash: null,
    reason: null,
    clientFingerprint: input.fingerprint,
    clickKey,
  };
  try {
    await getStore().insert("referrals", record);
  } catch (err) {
    if (err instanceof StoreConflictError) return { ok: true, value: { code, deduped: true } };
    throw err;
  }
  return { ok: true, value: { code, deduped: false } };
}

/** The referral attributed to a referred wallet, if any. */
export async function referralForReferred(referred: string): Promise<ReferralRecord | undefined> {
  return getStore().findOne("referrals", { referred: referred.toLowerCase() });
}

/**
 * Establish attribution for a referred wallet.
 *
 * First-touch wins and attribution is immutable: once a wallet is attributed to
 * a referrer, a later request with a different code does NOT overwrite it. A
 * self-referral is refused. Repeating the same attribution is idempotent.
 */
export async function attribute(
  input: { code: string; referred: string; fingerprint?: string; now?: number },
): Promise<Result<ReferralRecord>> {
  const now = input.now ?? Date.now();
  if (!isEvmAddress(input.referred)) return fail("invalid_address", "A valid wallet is required.");
  const referred = input.referred.toLowerCase();
  const code = normalizeCode(input.code);
  if (!code) return fail("invalid_code", "That referral code isn't valid.");

  const codeRow = await getStore().findOne("referralCodes", { code });
  if (!codeRow) return fail("invalid_code", "That referral code isn't valid.");
  const referrer = codeRow.owner;
  if (referrer === referred) return fail("self_referral", "You can't refer yourself.");

  const store = getStore();
  const existing = await referralForReferred(referred);
  if (existing) {
    if (existing.referrer === referrer) return { ok: true, value: existing };
    // Established attribution is not silently switched.
    return fail("already_attributed", "This wallet already has a referrer.");
  }

  const attributedCount = (await store.findMany("referrals", { referrer })).filter(
    (r) => r.state !== "clicked" && r.state !== "rejected",
  ).length;
  if (attributedCount >= MAX_ATTRIBUTIONS_PER_REFERRER) {
    return fail("referrer_limit", "This referrer has reached the attribution limit.");
  }

  const record: ReferralRecord = {
    id: randomUUID(),
    referrer,
    referred,
    code,
    state: "attributed",
    createdAt: now,
    updatedAt: now,
    attributedAt: now,
    qualifiedAt: null,
    qualifiedTxHash: null,
    reason: null,
    clientFingerprint: input.fingerprint ?? null,
    clickKey: null,
  };
  try {
    await store.insert("referrals", record);
  } catch (err) {
    if (err instanceof StoreConflictError) {
      // Lost a race: return whatever attribution now exists (never overwrite).
      const winner = await referralForReferred(referred);
      if (winner && winner.referrer === referrer) return { ok: true, value: winner };
      return fail("already_attributed", "This wallet already has a referrer.");
    }
    throw err;
  }
  return { ok: true, value: record };
}

/** Advance a referral to `registered` (no-op if already further along). */
export async function markRegistered(referred: string, now = Date.now()): Promise<Result<ReferralRecord>> {
  const existing = await referralForReferred(referred);
  if (!existing) return fail("not_attributed", "This wallet has no referral.");
  if (["registered", "activated", "pending_verification", "qualified"].includes(existing.state)) {
    return { ok: true, value: existing };
  }
  if (existing.state !== "attributed") return { ok: true, value: existing };
  await getStore().update("referrals", { id: existing.id }, { state: "registered", updatedAt: now });
  return { ok: true, value: { ...existing, state: "registered", updatedAt: now } };
}

/** Advance a referral to `activated` (a defined activation event occurred). */
export async function markActivated(referred: string, now = Date.now()): Promise<Result<ReferralRecord>> {
  const existing = await referralForReferred(referred);
  if (!existing) return fail("not_attributed", "This wallet has no referral.");
  if (["activated", "pending_verification", "qualified"].includes(existing.state)) {
    return { ok: true, value: existing };
  }
  if (existing.state === "rejected") return { ok: true, value: existing };
  await getStore().update("referrals", { id: existing.id }, { state: "activated", updatedAt: now });
  return { ok: true, value: { ...existing, state: "activated", updatedAt: now } };
}

export type QualifyInput = {
  referred: string;
  txHash: string;
  verifier: Verifier;
  now?: number;
};

/**
 * Attempt to qualify a referral from a transaction hash.
 *
 * The hash is untrusted; the verifier reads the chain. A definitive failure
 * (reverted, not the payer's tx, no transfer, wrong chain, bad hash) is a
 * `rejected` state. A transient/unavailable verification is
 * `pending_verification` — retryable, never counted as qualified, and never a
 * false rejection. Duplicate transactions and repeated calls are idempotent.
 */
export async function qualify(input: QualifyInput): Promise<Result<ReferralRecord>> {
  const now = input.now ?? Date.now();
  if (!isEvmAddress(input.referred)) return fail("invalid_address", "A valid wallet is required.");
  const referred = input.referred.toLowerCase();
  const store = getStore();
  const existing = await referralForReferred(referred);
  if (!existing) return fail("not_attributed", "This wallet has no referral to qualify.");

  // Idempotent: already qualified (even by this same tx) is success.
  if (existing.state === "qualified") return { ok: true, value: existing };
  if (existing.state === "rejected") {
    // A prior definitive rejection stands unless the outcome is retried with a
    // different (valid) transaction — allow a fresh attempt only from a
    // non-terminal pending state.
    return fail("duplicate_transaction", existing.reason ?? "This referral was rejected.");
  }

  // The attribution window bounds when qualification may happen.
  if (existing.attributedAt !== null && now - existing.attributedAt > ATTRIBUTION_WINDOW_MS) {
    await store.update("referrals", { id: existing.id }, { state: "rejected", reason: "window_expired", updatedAt: now });
    return fail("window_expired", "The referral window has expired.");
  }

  // The same transaction must not qualify two referrals.
  const txOwner = await store.findOne("referrals", { qualifiedTxHash: input.txHash });
  if (txOwner) {
    if (txOwner.referred === referred) return { ok: true, value: txOwner };
    return fail("duplicate_transaction", "That transaction has already qualified a referral.");
  }

  const result = await input.verifier({ txHash: input.txHash, referred });
  if (!result.ok) {
    // Retryable outcomes → pending_verification; definitive ones → rejected.
    const retryable = result.reason === "unavailable" || result.reason === "pending" || result.reason === "not_found";
    const state: ReferralState = retryable ? "pending_verification" : "rejected";
    await store.update(
      "referrals",
      { id: existing.id },
      { state, reason: result.reason, updatedAt: now },
    );
    return fail(retryable ? "not_attributed" : "duplicate_transaction", result.message);
  }

  // Persist qualification atomically. The unique `qualifiedTxHash` constraint
  // makes a concurrent double-qualification impossible: the loser sees the
  // winner's row and returns it.
  try {
    await store.transaction(async () => {
      const fresh = await referralForReferred(referred);
      if (!fresh) throw new StoreConflictError("referral disappeared");
      await store.update(
        "referrals",
        { id: fresh.id },
        { state: "qualified", qualifiedAt: now, qualifiedTxHash: input.txHash, reason: null, updatedAt: now },
      );
    });
  } catch (err) {
    if (err instanceof StoreConflictError) {
      const winner = await store.findOne("referrals", { qualifiedTxHash: input.txHash });
      if (winner) return { ok: true, value: winner };
    }
    throw err;
  }
  const qualified = await referralForReferred(referred);
  return { ok: true, value: qualified! };
}

/** Mark a referral rejected with a documented reason (authorized correction). */
export async function markRejected(referred: string, reason: string, now = Date.now()): Promise<Result<ReferralRecord>> {
  const existing = await referralForReferred(referred);
  if (!existing) return fail("not_attributed", "This wallet has no referral.");
  if (existing.state === "qualified") {
    return fail("already_attributed", "A qualified referral cannot be rejected without a correction.");
  }
  await getStore().update("referrals", { id: existing.id }, { state: "rejected", reason, updatedAt: now });
  return { ok: true, value: { ...existing, state: "rejected", reason, updatedAt: now } };
}

export type Dashboard = {
  owner: string;
  code: string;
  url: string;
  counts: {
    clicks: number;
    attributed: number;
    qualified: number;
    pending: number;
    rejected: number;
  };
  referrals: Array<{
    id: string;
    referred: string | null;
    state: ReferralState;
    attributedAt: number | null;
    qualifiedAt: number | null;
    reason: string | null;
  }>;
};

/** The referral dashboard for an owner — only ever their own records. */
export async function dashboardFor(
  owner: string,
  url: (code: string) => string,
  now = Date.now(),
): Promise<Result<Dashboard>> {
  if (!isEvmAddress(owner)) return fail("invalid_address", "Connect a wallet to view your referrals.");
  const lower = owner.toLowerCase();
  const code = await getCodeFor(lower);
  if (!code) return fail("invalid_code", "No referral code yet.");
  void now;
  const rows = await getStore().findMany("referrals", { referrer: lower }, { orderBy: "createdAt", dir: "desc" });
  const counts = {
    clicks: rows.filter((r) => r.state === "clicked").length,
    attributed: rows.filter((r) => r.state !== "clicked" && r.state !== "rejected").length,
    qualified: rows.filter((r) => r.state === "qualified").length,
    pending: rows.filter((r) => r.state === "pending_verification").length,
    rejected: rows.filter((r) => r.state === "rejected").length,
  };
  return {
    ok: true,
    value: {
      owner: lower,
      code,
      url: url(code),
      counts,
      referrals: rows
        .filter((r) => r.state !== "clicked")
        .map((r) => ({
          id: r.id,
          referred: r.referred,
          state: r.state,
          attributedAt: r.attributedAt,
          qualifiedAt: r.qualifiedAt,
          reason: r.reason,
        })),
    },
  };
}
