/**
 * The persistence contract shared by every store adapter.
 *
 * Intent Pay has no user accounts and no database today: identity is a
 * connected wallet, and all payment state lives in the browser. The capabilities
 * that need durable, *shared*, server-side state (referral attribution, payment
 * attempt correlation, operational error visibility, AI cost accounting) require
 * a real store with real constraints.
 *
 * Rather than pretend, this module defines the minimum the application needs and
 * provides two adapters:
 *   - `MemoryStore`  — pure, used by tests and as an honest fallback.
 *   - `SqliteStore`  — Node's built-in `node:sqlite`, which gives us genuine
 *                      UNIQUE / CHECK / FOREIGN KEY constraints and transactions
 *                      with no new dependency.
 *
 * A record is deliberately plain JSON: it can carry no private keys, signatures
 * or auth tokens (the callers never put them there), and it stays portable if the
 * deployment later moves to a managed database.
 */

export type StoreKind = "sqlite" | "memory";

/** A unique-constraint violation, shared by both adapters. */
export class StoreConflictError extends Error {
  code = "UNIQUE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

/** A referral relationship and its lifecycle state. */
export type ReferralState =
  | "clicked"
  | "attributed"
  | "registered"
  | "activated"
  | "pending_verification"
  | "qualified"
  | "rejected";

export type ReferralRecord = {
  /** Opaque public id (never a database row id). */
  id: string;
  /** The referrer's wallet address, lower-cased. */
  referrer: string;
  /** The referred wallet address, lower-cased, once known. */
  referred: string | null;
  /** The referral code used to attribute. */
  code: string;
  state: ReferralState;
  /** Unix ms. */
  createdAt: number;
  updatedAt: number;
  /** When attribution was established (the attribution window anchor). */
  attributedAt: number | null;
  /** When the qualifying event was verified. */
  qualifiedAt: number | null;
  /** The on-chain transaction hash that qualified this referral, if any. */
  qualifiedTxHash: string | null;
  /** A machine-readable reason for `rejected` / `pending_verification`. */
  reason: string | null;
  /** A coarse, privacy-preserving client fingerprint for abuse review. */
  clientFingerprint: string | null;
  /** A dedup key for a click event (code+fingerprint+day); unique when present. */
  clickKey: string | null;
};

export type ReferralCodeRecord = {
  /** The code itself, e.g. INTENT-7K4M9Q. Primary key — unique by construction. */
  code: string;
  /** The owning wallet address, lower-cased. */
  owner: string;
  createdAt: number;
};

/** A single payment attempt, correlated across its whole lifecycle. */
export type PaymentAttemptRecord = {
  /** The correlation id (a UUID-ish opaque string). */
  id: string;
  /** The connected wallet, lower-cased, when known. */
  account: string | null;
  createdAt: number;
  updatedAt: number;
  /** The last lifecycle status observed. */
  status: PaymentAttemptStatus;
  /** The latest machine-readable failure category, if any. */
  failureCategory: string | null;
  /** The intent fingerprint (executionKey) — never the raw instruction. */
  intentKey: string | null;
  /** The receive/pay symbols (public metadata; no amounts are sensitive). */
  receiveToken: string | null;
  payToken: string | null;
  /** "native" | "erc20" | "sponsored". */
  gasMode: string | null;
  /** The external provider involved, if any. */
  provider: string | null;
  /** The transaction hash, when one exists. */
  txHash: string | null;
  /** The UserOperation hash, when one exists. */
  userOpHash: string | null;
  /** The verified receipt status, when known. */
  receiptStatus: "success" | "reverted" | "unknown" | null;
  /** Whether delivery was independently proven. */
  deliveryVerified: boolean | null;
  /** Unix ms of the last time the authoritative chain was re-checked. */
  lastVerifiedAt: number | null;
  /** A bounded, redacted diagnostic string (never secrets). */
  diagnostic: string | null;
  /** An idempotency key supplied by the client for preparation. */
  idempotencyKey: string | null;
};

export type PaymentAttemptStatus =
  | "created"
  | "preparing"
  | "prepared"
  | "signing"
  | "awaiting_wallet"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "unknown"
  | "rejected";

/** A structured operational event (error/warning) for the ops view. */
export type OpsEventRecord = {
  id: string;
  at: number;
  /** "info" | "warning" | "error" | "critical". */
  severity: string;
  /** The failure/error category (shared taxonomy with payment attempts). */
  category: string;
  /** The API route or service that produced it. */
  service: string;
  /** A short, redacted message. Never a stack trace or secret. */
  message: string | null;
  /** The related payment attempt id, when applicable. */
  attemptId: string | null;
  /** Whether the issue is still considered unresolved. */
  unresolved: boolean;
};

/** A daily AI/provider cost rollup (estimated, never an invoice). */
export type CostRecord = {
  /** The UTC day, "YYYY-MM-DD". */
  day: string;
  /** The provider id (e.g. "openai", "pimlico"). */
  provider: string;
  /** The operation kind (e.g. "intent_llm"). */
  kind: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost as a decimal string (a calculation, never an invoice). */
  estimatedCostUsd: string;
  errors: number;
  retries: number;
};

/** A small server-side key/value table (session secret, budget config, nonces). */
export type KvRecord = {
  key: string;
  value: string;
  updatedAt: number;
};

/** The row shapes each adapter must persist. */
export type StoreTables = {
  referrals: ReferralRecord;
  referralCodes: ReferralCodeRecord;
  paymentAttempts: PaymentAttemptRecord;
  opsEvents: OpsEventRecord;
  costs: CostRecord;
  kv: KvRecord;
};

export type TableName = keyof StoreTables;

/**
 * The store interface. Deliberately small and synchronous: Node's sqlite adapter
 * is synchronous, and every operation here is a single fast statement, so an
 * async API would add ceremony without benefit.
 */
export interface Store {
  readonly kind: StoreKind;

  /** Insert, failing (throwing) on a unique-constraint violation. */
  insert<T extends TableName>(table: T, row: StoreTables[T]): void;
  /** Insert or replace by primary key. */
  upsert<T extends TableName>(table: T, row: StoreTables[T]): void;
  /** Fetch one row by a column equality. */
  findOne<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
  ): StoreTables[T] | undefined;
  /** Fetch many rows by a column equality, newest first when `orderBy` given. */
  findMany<T extends TableName>(
    table: T,
    where?: Partial<StoreTables[T]>,
    opts?: { limit?: number; orderBy?: keyof StoreTables[T]; dir?: "asc" | "desc" },
  ): StoreTables[T][];
  /** Update rows matching `where` with `patch`; returns the number changed. */
  update<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
    patch: Partial<StoreTables[T]>,
  ): number;
  /** Delete rows matching `where`; returns the number removed. */
  remove<T extends TableName>(table: T, where: Partial<StoreTables[T]>): number;
  /** Count rows matching `where`. */
  count<T extends TableName>(table: T, where?: Partial<StoreTables[T]>): number;
  /** Run `fn` inside a transaction (atomic; rolls back on throw). */
  transaction<T>(fn: () => T): T;
  /** Remove everything — tests only. */
  reset(): void;
}
