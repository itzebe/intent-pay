import type { TableName } from "./types";

/**
 * The single schema definition shared by both store adapters.
 *
 * Keeping the column mapping and the integrity rules in one place means the
 * in-memory adapter (tests) and the SQLite adapter (production) enforce the
 * *same* uniqueness and foreign-key rules — a test that passes on memory
 * reflects the real database constraints, not a weaker simulation.
 *
 * The integrity rules here are the ones the product depends on:
 *   - one referral code per wallet (unique owner) and globally unique codes,
 *   - a referred wallet can be attributed to exactly one referrer (immutable
 *     attribution),
 *   - a qualifying transaction hash can qualify at most one referral,
 *   - a wallet cannot refer itself,
 *   - an idempotency key maps to at most one payment attempt.
 */

export type ColumnType = "text" | "int" | "bool";

export type ColumnDef = {
  /** The camelCase field on the record. */
  field: string;
  /** The snake_case column name. */
  column: string;
  type: ColumnType;
  /** Nullable columns allow `null`; non-null columns reject it. */
  nullable?: boolean;
};

export type TableSchema = {
  name: TableName;
  /** The primary-key columns (a tuple for composite keys). */
  primaryKeys: string[];
  columns: ColumnDef[];
  /** Column-groups that must be unique together (NULLs do not collide). */
  uniqueGroups: string[][];
  /** Raw SQL CHECK clauses, appended to CREATE TABLE. */
  checks?: string[];
  /** Raw SQL FOREIGN KEY clauses. */
  foreignKeys?: string[];
};

const REFERRAL_STATES = [
  "clicked",
  "attributed",
  "registered",
  "activated",
  "pending_verification",
  "qualified",
  "rejected",
];

export const SCHEMA: TableSchema[] = [
  {
    name: "referralCodes",
    primaryKeys: ["code"],
    columns: [
      { field: "code", column: "code", type: "text" },
      { field: "owner", column: "owner", type: "text" },
      { field: "createdAt", column: "created_at", type: "int" },
    ],
    // A code is globally unique (primary key) AND a wallet owns exactly one.
    uniqueGroups: [["owner"]],
  },
  {
    name: "referrals",
    primaryKeys: ["id"],
    columns: [
      { field: "id", column: "id", type: "text" },
      { field: "referrer", column: "referrer", type: "text" },
      { field: "referred", column: "referred", type: "text", nullable: true },
      { field: "code", column: "code", type: "text" },
      { field: "state", column: "state", type: "text" },
      { field: "createdAt", column: "created_at", type: "int" },
      { field: "updatedAt", column: "updated_at", type: "int" },
      { field: "attributedAt", column: "attributed_at", type: "int", nullable: true },
      { field: "qualifiedAt", column: "qualified_at", type: "int", nullable: true },
      { field: "qualifiedTxHash", column: "qualified_tx_hash", type: "text", nullable: true },
      { field: "reason", column: "reason", type: "text", nullable: true },
      { field: "clientFingerprint", column: "client_fingerprint", type: "text", nullable: true },
      { field: "clickKey", column: "click_key", type: "text", nullable: true },
    ],
    // A referred wallet is attributed once; a tx qualifies once; a click event
    // (code+fingerprint+day) is counted once.
    uniqueGroups: [["referred"], ["qualifiedTxHash"], ["clickKey"]],
    checks: [`state IN (${REFERRAL_STATES.map((s) => `'${s}'`).join(", ")})`],
    foreignKeys: ["FOREIGN KEY(referrer) REFERENCES referral_codes(owner)"],
  },
  {
    name: "paymentAttempts",
    primaryKeys: ["id"],
    columns: [
      { field: "id", column: "id", type: "text" },
      { field: "account", column: "account", type: "text", nullable: true },
      { field: "createdAt", column: "created_at", type: "int" },
      { field: "updatedAt", column: "updated_at", type: "int" },
      { field: "status", column: "status", type: "text" },
      { field: "failureCategory", column: "failure_category", type: "text", nullable: true },
      { field: "intentKey", column: "intent_key", type: "text", nullable: true },
      { field: "receiveToken", column: "receive_token", type: "text", nullable: true },
      { field: "payToken", column: "pay_token", type: "text", nullable: true },
      { field: "gasMode", column: "gas_mode", type: "text", nullable: true },
      { field: "provider", column: "provider", type: "text", nullable: true },
      { field: "txHash", column: "tx_hash", type: "text", nullable: true },
      { field: "userOpHash", column: "user_op_hash", type: "text", nullable: true },
      { field: "receiptStatus", column: "receipt_status", type: "text", nullable: true },
      { field: "deliveryVerified", column: "delivery_verified", type: "bool", nullable: true },
      { field: "lastVerifiedAt", column: "last_verified_at", type: "int", nullable: true },
      { field: "diagnostic", column: "diagnostic", type: "text", nullable: true },
      { field: "idempotencyKey", column: "idempotency_key", type: "text", nullable: true },
    ],
    // A client idempotency key maps to at most one attempt.
    uniqueGroups: [["idempotencyKey"]],
  },
  {
    name: "opsEvents",
    primaryKeys: ["id"],
    columns: [
      { field: "id", column: "id", type: "text" },
      { field: "at", column: "at", type: "int" },
      { field: "severity", column: "severity", type: "text" },
      { field: "category", column: "category", type: "text" },
      { field: "service", column: "service", type: "text" },
      { field: "message", column: "message", type: "text", nullable: true },
      { field: "attemptId", column: "attempt_id", type: "text", nullable: true },
      { field: "unresolved", column: "unresolved", type: "bool" },
    ],
    uniqueGroups: [],
  },
  {
    name: "costs",
    primaryKeys: ["day", "provider", "kind"],
    columns: [
      { field: "day", column: "day", type: "text" },
      { field: "provider", column: "provider", type: "text" },
      { field: "kind", column: "kind", type: "text" },
      { field: "requests", column: "requests", type: "int" },
      { field: "inputTokens", column: "input_tokens", type: "int" },
      { field: "outputTokens", column: "output_tokens", type: "int" },
      { field: "estimatedCostUsd", column: "estimated_cost_usd", type: "text" },
      { field: "errors", column: "errors", type: "int" },
      { field: "retries", column: "retries", type: "int" },
    ],
    // The rollup is keyed by (day, provider, kind) — a composite primary key.
    uniqueGroups: [["day", "provider", "kind"]],
  },
  {
    name: "kv",
    primaryKeys: ["key"],
    columns: [
      { field: "key", column: "key", type: "text" },
      { field: "value", column: "value", type: "text" },
      { field: "updatedAt", column: "updated_at", type: "int" },
    ],
    uniqueGroups: [],
  },
];

export function schemaFor(table: TableName): TableSchema {
  const s = SCHEMA.find((x) => x.name === table);
  if (!s) throw new Error(`Unknown store table: ${table}`);
  return s;
}

/** The column definition for a record field, or undefined if it isn't stored. */
export function columnForField(schema: TableSchema, field: string): ColumnDef | undefined {
  return schema.columns.find((c) => c.field === field);
}

/** Encode a JS value for the column type. */
export function encodeValue(type: ColumnType, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (type === "bool") return value ? 1 : 0;
  if (type === "int") return typeof value === "number" ? Math.trunc(value) : Number(value);
  return String(value);
}

/** Decode a column value back to the JS type. */
export function decodeValue(type: ColumnType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (type === "bool") return value === 1 || value === true || value === "1";
  if (type === "int") return typeof value === "number" ? value : Number(value);
  return String(value);
}
