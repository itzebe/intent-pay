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

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${qi("_migrations")} (${qi("id")} INTEGER PRIMARY KEY, ${qi("applied_at")} BIGINT NOT NULL)`,
      ...TABLES,
      ...INDEXES,
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
