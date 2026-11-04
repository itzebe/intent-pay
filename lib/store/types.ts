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
 *
 * v2 adds the external developer API tables (developers, API keys, intents,
 * intent events, webhooks, webhook deliveries).
 * v3 adds merchant checkout sessions (`apiCheckouts`), which bind a payable
 * order to a developer-API intent.
 */
export const SCHEMA_VERSION = 3;

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

// ---------------------------------------------------------------------------
// External developer API (v1)
//
// Independent applications authenticate with an API key and drive payment
// intents through their own wallet. Nothing here is a private key or a
// signature: a developer record holds only a public id, a name and a status; an
// API key record holds a public prefix plus a *hash* of the secret, never the
// secret itself. See `lib/developer/*`.
// ---------------------------------------------------------------------------

/** A developer account (a tenant). Owns API keys, intents and webhooks. */
export type ApiDeveloperRecord = {
  /** Opaque public id (`dev_…`). Never a row id. */
  id: string;
  name: string;
  /** "active" | "suspended". A suspended developer cannot authenticate. */
  status: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * An API key. The secret is never stored: only a salted hash. `prefix` is the
 * public, displayable part (`ipk_live_ab12…`) used to look a key up without
 * scanning every hash. `environment` separates a real key ("live") from a
 * development/test key ("test"), which is refused in production.
 */
export type ApiKeyRecord = {
  /** Opaque public id (`key_…`). */
  id: string;
  developerId: string;
  /** Human label for the key. */
  name: string;
  /** Public, non-secret prefix of the key (lookup handle). */
  prefix: string;
  /** Salted hash of the secret half. The secret itself is never persisted. */
  secretHash: string;
  /** The salt used for `secretHash`. */
  salt: string;
  /** "live" | "test". A "test" key is refused when NODE_ENV is production. */
  environment: string;
  /** "active" | "revoked". A revoked key never authenticates. */
  status: string;
  /** Unix ms expiry, or null for no expiry. */
  expiresAt: number | null;
  createdAt: number;
  /** Unix ms of the last successful authentication, or null. */
  lastUsedAt: number | null;
  /** Unix ms the key was revoked, or null. */
  revokedAt: number | null;
  updatedAt: number;
};

/**
 * A payment intent created through the developer API.
 *
 * The intent is the *request*; it is not a transaction and not a payment. Its
 * lifecycle state is derived from the ordered `apiIntentEvents` rows (see
 * `lib/developer/intentLifecycle.ts`), so the history is append-only and
 * auditable rather than a mutable status field.
 */
export type ApiIntentRecord = {
  /** Opaque public id (`int_…`). */
  id: string;
  /** The owning developer (tenant). Every read is scoped by this. */
  developerId: string;
  /** The API key that created it, for audit. */
  createdByKeyId: string;
  /** Monad chain id (always 143 for now). */
  chainId: number;
  /** The recipient address (lower-cased). Immutable after authorization. */
  recipient: string;
  /** Receive-token symbol as requested. */
  receiveToken: string;
  /** Receive-token contract address (lower-cased), resolved at creation. */
  receiveTokenAddress: string;
  /** "recipient_receives" | "i_spend". */
  amountMode: string;
  /** Decimal-string amount as requested. Immutable after authorization. */
  amount: string;
  /** Optional fixed pay token (symbol), when the caller chooses one. */
  payToken: string | null;
  /** Optional client reference, echoed back for the developer's own mapping. */
  reference: string | null;
  /**
   * The exact authorized parameters (a canonical JSON string), frozen at
   * `AWAITING_AUTHORIZATION`. A prepare/authorize after this point must match it
   * byte-for-byte, so a recipient or amount can never be swapped post-auth.
   */
  authorizedParams: string | null;
  /** The idempotency key supplied at creation, if any. */
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
};

/** An append-only lifecycle event for an intent. */
export type ApiIntentEventRecord = {
  id: string;
  intentId: string;
  developerId: string;
  /** A `IntentState` value. */
  state: string;
  /** Unix ms. */
  at: number;
  /** A short, non-sensitive detail (never a secret or a raw provider string). */
  detail: string | null;
};

/** A registered webhook destination. The signing secret is never returned. */
export type ApiWebhookRecord = {
  id: string;
  developerId: string;
  /** HTTPS endpoint. */
  url: string;
  /** A short description. */
  description: string | null;
  /** Comma-joined subscribed event names, or "*" for all. */
  events: string;
  /** HMAC signing secret. Stored so deliveries can be signed; never returned. */
  secret: string;
  /** "active" | "disabled". */
  status: string;
  createdAt: number;
  updatedAt: number;
};

/** One delivery attempt of one event to one webhook. */
export type ApiWebhookDeliveryRecord = {
  id: string;
  webhookId: string;
  developerId: string;
  /** The event name (`intent.created`, `payment.verified`, …). */
  event: string;
  /** A unique event id, stable across retries (also the dedupe key). */
  eventId: string;
  /** The JSON body delivered (already stripped of secrets). */
  payload: string;
  /** "pending" | "delivered" | "failed". */
  status: string;
  /** How many attempts have been made. */
  attempts: number;
  /** Unix ms when the next attempt is due, or null when done. */
  nextAttemptAt: number | null;
  /** Unix ms of the last attempt. */
  lastAttemptAt: number | null;
  /** The last HTTP status code, when a response was received. */
  lastStatusCode: number | null;
  /** A short, non-sensitive error, when the attempt failed. */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * A merchant checkout session.
 *
 * A checkout is the *payable order*: a developer creates one (bound to a
 * developer-API intent that holds the amount/asset/recipient), shares its
 * payment link with a customer, and reads its status back. It deliberately does
 * **not** duplicate the payment parameters — the amount, asset and recipient
 * live on the bound intent, so they cannot drift or be re-specified, and the
 * existing freeze-before-sign protection applies unchanged.
 *
 * The `token` is a public payment-link handle: 256 bits of CSPRNG entropy that a
 * customer's browser uses to read the session. It is a bearer capability for one
 * order (it grants only the ability to view and pay that order — money flows to
 * the merchant), so it is stored so the merchant can retrieve and copy the link,
 * exactly as a hosted-checkout URL is. It is never a credential: it cannot read
 * another tenant's data, mutate an authorized order, or move funds anywhere but
 * to the merchant's own recipient.
 */
export type ApiCheckoutRecord = {
  /** Opaque public id (`chk_…`). */
  id: string;
  /** The owning developer (tenant). Every read is scoped by this. */
  developerId: string;
  /** The bound developer-API intent that holds the payment parameters. */
  intentId: string;
  /** The merchant's own order reference, echoed back for their mapping. */
  orderReference: string | null;
  /** The public, unguessable payment-link token (unique). */
  token: string;
  /** A short display handle (last 8 chars) for the dashboard list. */
  tokenHint: string;
  /**
   * The derived lifecycle status, mirrored here for fast listing:
   * "open" | "completed" | "expired" | "canceled" | "failed". The *payment*
   * truth (submitted/confirmed/verified) always comes from the bound intent.
   */
  status: string;
  /** Unix ms expiry — after this the checkout can no longer be paid. */
  expiresAt: number;
  /** Unix ms the checkout was paid+verified, or null. */
  completedAt: number | null;
  /** Unix ms the checkout was canceled by the merchant, or null. */
  canceledAt: number | null;
  /** The idempotency key supplied at creation, if any. */
  idempotencyKey: string | null;
  createdAt: number;
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
  apiDevelopers: ApiDeveloperRecord;
  apiKeys: ApiKeyRecord;
  apiIntents: ApiIntentRecord;
  apiIntentEvents: ApiIntentEventRecord;
  apiWebhooks: ApiWebhookRecord;
  apiWebhookDeliveries: ApiWebhookDeliveryRecord;
  apiCheckouts: ApiCheckoutRecord;
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
