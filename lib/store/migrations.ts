import { SCHEMA } from "./schema";
import { SCHEMA_VERSION } from "./types";
import type { TableSchema } from "./schema";

/**
 * Versioned Postgres migrations.
 *
 * The column mapping and integrity rules live in `schema.ts`, shared with the
 * SQLite and in-memory adapters, so Postgres enforces the *same* constraints the
 * product depends on:
 *   - a referral code is globally unique and a wallet owns exactly one,
 *   - a referred wallet is attributed once (immutable first touch),
 *   - a qualifying transaction hash qualifies at most one referral,
 *   - a client idempotency key maps to at most one payment attempt,
 *   - `state` is one of the known referral states.
 *
 * Migrations are ordered by `id` and applied at most once, recorded in
 * `_migrations`. They are written to be idempotent (`IF NOT EXISTS`) so a
 * partially-applied run is safe to repeat. `SCHEMA_VERSION` is the highest id
 * and is what `health()` compares against: a connection that has not run the
 * migrations reports `ready: false`, so a bare database URL is never mistaken
 * for durable storage.
 */

/** camelCase table name -> snake_case (referralCodes -> referral_codes). */
export function snake(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** Quote a Postgres identifier so reserved words can never break the DDL. */
export function qi(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function pgType(type: TableSchema["columns"][number]["type"]): string {
  return type === "int" ? "BIGINT" : type === "bool" ? "BOOLEAN" : "TEXT";
}

/** Build the `CREATE TABLE` statement for one table from the shared schema. */
function createTable(schema: TableSchema): string {
  const cols = schema.columns
    .map((c) => `${qi(c.column)} ${pgType(c.type)}${c.nullable ? "" : " NOT NULL"}`)
    .join(", ");
  const pk = `PRIMARY KEY (${schema.primaryKeys
    .map((f) => qi(schema.columns.find((c) => c.field === f)!.column))
    .join(", ")})`;
  const unique = schema.uniqueGroups
    .map((g) => `UNIQUE (${g.map((f) => qi(schema.columns.find((c) => c.field === f)!.column)).join(", ")})`)
    .join(", ");
  const checks = (schema.checks ?? []).map((c) => `CHECK (${c})`).join(", ");
  const fks = (schema.foreignKeys ?? []).join(", ");
  const extras = [pk, unique, checks, fks].filter(Boolean).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${qi(snake(schema.name))} (${cols}, ${extras})`;
}

/**
 * A migration is a list of statements applied inside one transaction. Statement
 * 1 always creates the ledger; the remaining statements create/alter the tables.
 */
export type Migration = { id: number; statements: string[] };

const TABLES: string[] = SCHEMA.map(createTable);

/** Indexes that speed the real read patterns (recent ops, per-referrer lists). */
const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_ops_events_at ON ${qi("ops_events")} (${qi("at")} DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON ${qi("referrals")} (${qi("referrer")})`,
  `CREATE INDEX IF NOT EXISTS idx_costs_day ON ${qi("costs")} (${qi("day")})`,
];

/**
 * Indexes for the external developer API read patterns: an intent list per
 * tenant (newest first), an intent's event history in order, a tenant's
 * webhooks, and the deliveries due for retry.
 */
const DEVELOPER_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_api_intents_dev ON ${qi("api_intents")} (${qi("developer_id")}, ${qi("created_at")} DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_api_intent_events_intent ON ${qi("api_intent_events")} (${qi("intent_id")}, ${qi("at")})`,
  `CREATE INDEX IF NOT EXISTS idx_api_webhooks_dev ON ${qi("api_webhooks")} (${qi("developer_id")})`,
  `CREATE INDEX IF NOT EXISTS idx_api_deliveries_due ON ${qi("api_webhook_deliveries")} (${qi("status")}, ${qi("next_attempt_at")})`,
];

/** Indexes for the merchant checkout read patterns (per-tenant list, by intent). */
const CHECKOUT_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_api_checkouts_dev ON ${qi("api_checkouts")} (${qi("developer_id")}, ${qi("created_at")} DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_api_checkouts_intent ON ${qi("api_checkouts")} (${qi("intent_id")})`,
];

/**
 * Indexes for the transaction-claim guard: the primary key (chain_id, tx_hash)
 * already makes the claim unique, and this index speeds the per-intent lookup
 * used to describe an order's consumed transaction.
 */
const TX_CLAIM_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_api_tx_claims_intent ON ${qi("api_tx_claims")} (${qi("intent_id")})`,
];

/**
 * v5 — checkout-specific attribution. The merchant may register a watch-only
 * payment xpub; each checkout then derives a unique destination so a transfer can
 * only settle the order it was created for.
 *
 * These are `ADD COLUMN IF NOT EXISTS` statements (not a re-`CREATE TABLE`),
 * because the production tables already exist and `CREATE TABLE IF NOT EXISTS` is
 * a no-op for them. The added columns are nullable (or defaulted) so existing
 * rows — every checkout created before this version — remain valid and simply
 * carry `attribution_address = NULL` (the shared-recipient fallback).
 */
const ATTRIBUTION_COLUMNS: string[] = [
  `ALTER TABLE ${qi("api_developers")} ADD COLUMN IF NOT EXISTS ${qi("payment_xpub")} TEXT`,
  `ALTER TABLE ${qi("api_developers")} ADD COLUMN IF NOT EXISTS ${qi("next_derivation_index")} BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE ${qi("api_checkouts")} ADD COLUMN IF NOT EXISTS ${qi("attribution_address")} TEXT`,
  `ALTER TABLE ${qi("api_checkouts")} ADD COLUMN IF NOT EXISTS ${qi("derivation_index")} BIGINT`,
];

/** A unique destination per checkout: no two orders may share an address. */
const ATTRIBUTION_INDEXES: string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_api_checkouts_attribution ON ${qi("api_checkouts")} (${qi("attribution_address")}) WHERE ${qi("attribution_address")} IS NOT NULL`,
];

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${qi("_migrations")} (${qi("id")} INTEGER PRIMARY KEY, ${qi("applied_at")} BIGINT NOT NULL)`,
      ...TABLES,
      ...INDEXES,
    ],
  },
  {
    // v2 — external developer API. `TABLES` is derived from the shared schema,
    // so this migration creates the six new tables (and harmlessly re-issues the
    // v1 tables via IF NOT EXISTS).
    id: 2,
    statements: [...TABLES, ...DEVELOPER_INDEXES],
  },
  {
    // v3 — merchant checkout sessions.
    id: 3,
    statements: [...TABLES, ...CHECKOUT_INDEXES],
  },
  {
    // v4 — durable transaction claims (the (chainId, txHash) replay guard).
    id: 4,
    statements: [...TABLES, ...TX_CLAIM_INDEXES],
  },
  {
    // v5 — checkout-specific attribution (per-checkout derived destination).
    id: 5,
    statements: [...ATTRIBUTION_COLUMNS, ...ATTRIBUTION_INDEXES],
  },
  {
    // v6 — self-service developer signup. `TABLES` re-issues every table
    // (`IF NOT EXISTS`, so the existing ones are untouched) which creates the new
    // `api_email_verifications` table; the explicit `ALTER TABLE ... ADD COLUMN
    // IF NOT EXISTS` statements add `email` / `email_verified_at` to the existing
    // `api_developers` table. The email uniqueness index is created for the
    // verified-email invariant (NULLs do not collide).
    id: 6,
    statements: [
      ...TABLES,
      `ALTER TABLE ${qi("api_developers")} ADD COLUMN IF NOT EXISTS ${qi("email")} TEXT`,
      `ALTER TABLE ${qi("api_developers")} ADD COLUMN IF NOT EXISTS ${qi("email_verified_at")} BIGINT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_api_developers_email ON ${qi("api_developers")} (${qi("email")}) WHERE ${qi("email")} IS NOT NULL`,
    ],
  },
];

export const LATEST_MIGRATION = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);

/** Fail loudly if the schema and the migration ledger ever disagree. */
if (LATEST_MIGRATION !== SCHEMA_VERSION) {
  throw new Error(
    `store schema drift: SCHEMA_VERSION=${SCHEMA_VERSION} but LATEST_MIGRATION=${LATEST_MIGRATION}`,
  );
}
