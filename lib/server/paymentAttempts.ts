import { randomUUID } from "node:crypto";
import { getStore } from "@/lib/store";
import type { PaymentAttemptRecord, PaymentAttemptStatus } from "@/lib/store/types";
import { classifyCode, type FailureCategory } from "@/lib/domain/failureTaxonomy";

/**
 * Payment attempt correlation.
 *
 * Every payment gets one opaque id that follows it through preparation,
 * signing, submission, and receipt handling. The record is deliberately narrow:
 * it stores *what happened at each stage*, never the raw instruction, amounts,
 * signatures, or any secret. The intent is identified by its `executionKey`
 * fingerprint (already computed by the canonical-intent layer), and the tokens
 * by symbol — both public metadata.
 *
 * Idempotency: when a client supplies an idempotency key, `createAttempt`
 * returns the existing attempt for that key instead of creating a second one.
 * This is a *server-side preparation* guard. It does not, and cannot, guarantee
 * that a wallet-broadcast transaction is never duplicated — the wallet signs and
 * broadcasts directly. It only ensures that repeating a preparation request does
 * not create a parallel record.
 */

const MAX_DIAGNOSTIC = 300;

/**
 * Patterns for material that must never be persisted in a diagnostic: API keys,
 * bearer tokens, and secret-like query/assignment values. Redaction is a safety
 * net, not a licence to log secrets.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|api|key|token|secret)[-_][-_A-Za-z0-9]{8,}\b/gi,
  /\b(sk|pk|api|key|token|secret)[A-Za-z0-9]{12,}\b/gi,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /(bearer\s+)[A-Za-z0-9._-]+/gi,
];

export function newAttemptId(): string {
  return randomUUID();
}

/** Strip control characters, scrub obvious secrets, and cap length. */
export function redactDiagnostic(message: string | undefined | null): string | null {
  if (!message) return null;
  let out = message;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_DIAGNOSTIC);
}

export type CreateAttemptInput = {
  account?: string | null;
  intentKey?: string | null;
  receiveToken?: string | null;
  payToken?: string | null;
  gasMode?: string | null;
  provider?: string | null;
  idempotencyKey?: string | null;
  diagnostic?: string | null;
};

/**
 * Create (or return the existing) payment attempt.
 *
 * The idempotency key is unique at the database level, so two concurrent
 * requests with the same key cannot both insert: the loser gets the winner's
 * record. A missing key always creates a new attempt (no cross-request dedup).
 */
export function createAttempt(input: CreateAttemptInput, now = Date.now()): PaymentAttemptRecord {
  const store = getStore();
  const key = input.idempotencyKey?.trim() || null;
  if (key) {
    const existing = store.findOne("paymentAttempts", { idempotencyKey: key });
    if (existing) return existing;
  }
  const record: PaymentAttemptRecord = {
    id: newAttemptId(),
    account: input.account?.toLowerCase() ?? null,
    createdAt: now,
    updatedAt: now,
    status: "created",
    failureCategory: null,
    intentKey: input.intentKey ?? null,
    receiveToken: input.receiveToken ?? null,
    payToken: input.payToken ?? null,
    gasMode: input.gasMode ?? null,
    provider: input.provider ?? null,
    txHash: null,
    userOpHash: null,
    receiptStatus: null,
    deliveryVerified: null,
    lastVerifiedAt: null,
    diagnostic: redactDiagnostic(input.diagnostic),
    idempotencyKey: key,
  };
  try {
    store.insert("paymentAttempts", record);
  } catch {
    // Lost a race on the idempotency key — return the winner's record.
    if (key) {
      const winner = store.findOne("paymentAttempts", { idempotencyKey: key });
      if (winner) return winner;
    }
    throw new Error("Could not create the payment attempt.");
  }
  return record;
}

export type UpdateAttemptInput = {
  status?: PaymentAttemptStatus;
  failureCategory?: FailureCategory | null;
  txHash?: string | null;
  userOpHash?: string | null;
  receiptStatus?: "success" | "reverted" | "unknown" | null;
  deliveryVerified?: boolean | null;
  gasMode?: string | null;
  provider?: string | null;
  diagnostic?: string | null;
  lastVerifiedAt?: number | null;
};

export function updateAttempt(id: string, patch: UpdateAttemptInput, now = Date.now()): PaymentAttemptRecord | undefined {
  const store = getStore();
  const existing = store.findOne("paymentAttempts", { id });
  if (!existing) return undefined;
  const next: Partial<PaymentAttemptRecord> = { updatedAt: now };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.failureCategory !== undefined) next.failureCategory = patch.failureCategory;
  if (patch.txHash !== undefined) next.txHash = patch.txHash;
  if (patch.userOpHash !== undefined) next.userOpHash = patch.userOpHash;
  if (patch.receiptStatus !== undefined) next.receiptStatus = patch.receiptStatus;
  if (patch.deliveryVerified !== undefined) next.deliveryVerified = patch.deliveryVerified;
  if (patch.gasMode !== undefined) next.gasMode = patch.gasMode;
  if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.diagnostic !== undefined) next.diagnostic = redactDiagnostic(patch.diagnostic);
  if (patch.lastVerifiedAt !== undefined) next.lastVerifiedAt = patch.lastVerifiedAt;
  store.update("paymentAttempts", { id }, next);
  return store.findOne("paymentAttempts", { id });
}

export function getAttempt(id: string): PaymentAttemptRecord | undefined {
  return getStore().findOne("paymentAttempts", { id });
}

export function listAttempts(limit = 100): PaymentAttemptRecord[] {
  return getStore().findMany("paymentAttempts", undefined, { orderBy: "createdAt", dir: "desc", limit });
}

/**
 * Classify a failure code and persist it. Keeps the "may have submitted"
 * distinction explicit so the caller can require reconciliation before retry.
 */
export function recordFailure(
  id: string,
  code: string | null | undefined,
  source: "readiness" | "quote" | "guard" | "execution" | "wallet" | "aa" | "generic",
  diagnostic?: string,
  now = Date.now(),
): { category: FailureCategory; mayHaveSubmitted: boolean } {
  const cls = classifyCode(code, source);
  const status: PaymentAttemptStatus =
    cls.category === "user_rejected"
      ? "rejected"
      : cls.mayHaveSubmitted
        ? cls.category === "transaction_reverted"
          ? "failed"
          : "unknown"
        : "failed";
  updateAttempt(
    id,
    {
      status,
      failureCategory: cls.category,
      diagnostic: diagnostic ?? cls.message,
      ...(cls.category === "transaction_reverted" ? { receiptStatus: "reverted" as const } : {}),
    },
    now,
  );
  return { category: cls.category, mayHaveSubmitted: cls.mayHaveSubmitted };
}
