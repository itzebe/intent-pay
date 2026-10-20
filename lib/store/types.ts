/**
 * The persistence contract shared by every store adapter.
 *
 * Intent Pay has no user accounts: identity is a connected wallet, and payment
 * state lives in the browser. The capabilities that need durable, *shared*,
 * server-side state (referral attribution, payment attempt correlation,
 * operational error visibility, AI cost accounting) use this small store.
 *
 * Rather than pretend, this module defines the minimum the application needs and
 * provides three adapters:
 *   - `MemoryStore`   — pure, used by tests and as an honest fallback.
 *   - `SqliteStore`   — Node's built-in `node:sqlite`, genuine UNIQUE / CHECK /
 *                       FOREIGN KEY constraints and transactions, no dependency.
 *   - `PostgresStore` — a managed Postgres (e.g. Neon), the only genuinely
 *                       durable option on an ephemeral/serverless filesystem.
 *
 * Durability is a property of the *configuration*, not the adapter: a temp-dir
 * SQLite file is ephemeral. `storeCapability()` reports the honest state and
 * callers that require durability (`requireDurableStore`) refuse rather than
 * pretend.
 *
 * The interface is **asynchronous**. Every method returns a Promise even when an
 * adapter (memory, sqlite) could answer synchronously, because a remote database
 * cannot: a synchronous interface would force a fake blocking bridge, which is
 * neither safe nor correct under serverless concurrency. Keeping one async
 * contract lets the same referral logic run against every backend unchanged.
 *
 * A record is deliberately plain JSON: it can carry no private keys, signatures
 * or auth tokens (the callers never put them there), and it stays portable across
 * backends.
 */

export type StoreKind = "postgres" | "sqlite" | "memory";

/**
 * A structural change to the persisted data (a new column, index, constraint or
 * table). Adapters expose the highest migration id they have applied so the
 * capabilities surface can prove the required schema is really present rather
 * than merely assume a connection implies a migrated database.
 */
export const SCHEMA_VERSION = 1;

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
 * The store interface. Asynchronous by contract (see the module comment): a
 * remote database cannot be queried synchronously, and every method here is a
 * single fast statement, so the only cost of async is an `await` at the call
 * site. The sqlite/memory adapters resolve immediately.
 */
export interface Store {
  readonly kind: StoreKind;

  /** Insert, failing (throwing) on a unique-constraint violation. */
  insert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void>;
  /** Insert or replace by primary key. */
  upsert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void>;
  /** Fetch one row by a column equality. */
  findOne<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
  ): Promise<StoreTables[T] | undefined>;
  /** Fetch many rows by a column equality, newest first when `orderBy` given. */
  findMany<T extends TableName>(
    table: T,
    where?: Partial<StoreTables[T]>,
    opts?: { limit?: number; orderBy?: keyof StoreTables[T]; dir?: "asc" | "desc" },
  ): Promise<StoreTables[T][]>;
  /** Update rows matching `where` with `patch`; returns the number changed. */
  update<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
    patch: Partial<StoreTables[T]>,
  ): Promise<number>;
  /** Delete rows matching `where`; returns the number removed. */
  remove<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<number>;
  /** Count rows matching `where`. */
  count<T extends TableName>(table: T, where?: Partial<StoreTables[T]>): Promise<number>;
  /** Run `fn` inside a transaction (atomic; rolls back on throw). */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Liveness + schema readiness. A reachable connection is not enough: a
   * configured database that has not been migrated must report `ready: false`,
   * so durability is never claimed on the strength of a URL alone.
   */
  health(): Promise<StoreHealth>;
  /** Remove everything — tests only. */
  reset(): Promise<void>;
}

/** The honest result of probing a store's liveness and schema readiness. */
export type StoreHealth = {
  /** Whether a trivial query round-tripped. */
  reachable: boolean;
  /** Whether the required schema is present at the expected version. */
  ready: boolean;
  /** The migration id the store reports it has applied, when known. */
  schemaVersion: number | null;
  /** A short, non-sensitive failure reason (never a credential or a path). */
  error?: string;
};
