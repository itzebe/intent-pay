import type { Store, StoreHealth } from "./types";
import { SCHEMA_VERSION } from "./types";
import { MemoryStore } from "./memory";
import { SqliteStore } from "./sqlite";
import { PostgresStore } from "./postgres";

export type { Store, TableName, StoreTables, StoreHealth } from "./types";
export { SCHEMA_VERSION } from "./types";
export { MemoryStore, StoreConflictError } from "./memory";
export { SqliteStore } from "./sqlite";
export { PostgresStore } from "./postgres";

/**
 * The process-wide store.
 *
 * Backend selection, in priority order:
 *   1. `DATABASE_URL` / `INTENT_PAY_DATABASE_URL` set → managed Postgres (Neon).
 *      This is the only backend that is genuinely durable on Vercel.
 *   2. `INTENT_PAY_DB_PATH` set (and not forced to memory) → on-disk SQLite.
 *   3. otherwise → a temp-dir SQLite file, or in-memory when `node:sqlite` is
 *      unavailable. Both are ephemeral and are reported as such.
 *
 * Durability is NOT the same as "a database is configured". A Postgres URL can be
 * present while the database is unreachable or un-migrated; `storeCapability()`
 * probes the backend (a real query plus a schema-version check) and only reports
 * `durable` when the data can actually be persisted and read back. The referral
 * feature refuses to claim durable attribution it cannot deliver, and the store
 * kind is surfaced through `/api/capabilities`. The store never fabricates a
 * record and never silently reports ephemeral storage as persistent.
 *
 * IMPORTANT: durable access is asynchronous (a remote database is). `getStore()`
 * returns the adapter synchronously (construction never touches the network), but
 * `storeCapability()` and `requireDurableStore()` are async because they verify.
 */

let singleton: Store | null = null;
let overrideStore: Store | null = null;

/** The Postgres connection string, if one is configured. */
export function postgresUrl(): string | null {
  const url = process.env.INTENT_PAY_DATABASE_URL || process.env.DATABASE_URL;
  return url && url.trim() ? url.trim() : null;
}

/** The default on-disk database path. */
export function defaultDbPath(): string {
  if (process.env.INTENT_PAY_DB_PATH) return process.env.INTENT_PAY_DB_PATH;
  // Prefer a writable temp location so a read-only deploy root never crashes.
  const base = process.env.TMPDIR || process.env.TEMP || "/tmp";
  return `${base.replace(/\/$/, "")}/intent-pay.sqlite`;
}

function createStore(): Store {
  const pg = postgresUrl();
  if (pg && process.env.INTENT_PAY_STORE !== "memory") return new PostgresStore(pg);
  if (process.env.INTENT_PAY_STORE === "memory") return new MemoryStore();
  try {
    return new SqliteStore(defaultDbPath());
  } catch {
    // `node:sqlite` unavailable (older Node, edge runtime) — degrade honestly.
    return new MemoryStore();
  }
}

export function getStore(): Store {
  if (overrideStore) return overrideStore;
  if (!singleton) singleton = createStore();
  return singleton;
}

/** Replace the process store — tests only. */
export function setStore(store: Store | null): void {
  overrideStore = store;
}

/** The store kind actually in use (for honest capability reporting). */
export function storeKind(): Store["kind"] {
  return getStore().kind;
}

export type StoreCapability = {
  kind: Store["kind"];
  /**
   *   - "memory"     — in-memory only; nothing survives a process restart.
   *   - "ephemeral"  — an on-disk SQLite file in an ephemeral location (the
   *                    default OS temp dir), or an unreachable/un-migrated
   *                    remote database. Real constraints, but not durable.
   *   - "persistent" — a verified, reachable, migrated database (Postgres, or an
   *                    on-disk SQLite file at an explicitly configured path).
   */
  durability: "memory" | "ephemeral" | "persistent";
  durable: boolean;
  /** The database really answered a query. */
  reachable: boolean;
  /** The required schema is present at the expected version. */
  schemaReady: boolean;
  schemaVersion: number | null;
  requiredSchemaVersion: number;
  /** A short, non-sensitive reason when not durable (never a credential/path). */
  reason: string | null;
};

function probeReason(kind: Store["kind"], health: StoreHealth): string {
  if (!health.reachable) {
    return kind === "postgres"
      ? "The configured database could not be reached, so referral data cannot be saved."
      : "The storage backend is not reachable.";
  }
  if (!health.ready) {
    return kind === "postgres"
      ? "The configured database is reachable but its schema is not migrated, so referral data cannot be saved. Run the database migration."
      : "The storage schema is not at the required version.";
  }
  return "Storage is not durable.";
}

/**
 * Probe the store and report exactly how durable it is. This performs a real
 * round-trip for the remote backend, so a configured-but-unreachable or
 * un-migrated database reports `durable: false` with a reason — never a false
 * success. Nothing sensitive (no path, no credential) is returned.
 */
export async function storeCapability(): Promise<StoreCapability> {
  const store = getStore();
  const base = { kind: store.kind, requiredSchemaVersion: SCHEMA_VERSION } as const;

  if (store.kind === "memory") {
    return {
      ...base,
      durability: "memory",
      durable: false,
      reachable: true,
      schemaReady: true,
      schemaVersion: SCHEMA_VERSION,
      reason:
        "Referral attribution needs durable storage, but this deployment is running with an in-memory store. No referral data will be saved.",
    };
  }

  if (store.kind === "sqlite") {
    const health = await store.health();
    // An on-disk SQLite file is only "persistent" when its path is explicitly
    // configured; a temp-dir file is erased on a serverless cold start.
    const configured = Boolean(process.env.INTENT_PAY_DB_PATH);
    if (configured && health.reachable && health.ready) {
      return {
        ...base,
        durability: "persistent",
        durable: true,
        reachable: true,
        schemaReady: true,
        schemaVersion: health.schemaVersion,
        reason: null,
      };
    }
    return {
      ...base,
      durability: "ephemeral",
      durable: false,
      reachable: health.reachable,
      schemaReady: health.ready,
      schemaVersion: health.schemaVersion,
      reason:
        health.reachable && health.ready
          ? "Referral attribution needs durable storage, but this deployment stores data in an ephemeral filesystem that is erased on restart. Configure a managed Postgres database (DATABASE_URL) to enable durable referrals."
          : probeReason(store.kind, health),
    };
  }

  // Postgres: durable only when it is actually reachable and migrated. Apply
  // pending migrations first (idempotent) so a fresh database self-heals on the
  // first probe; if the database is unreachable the migration throws and the
  // health check below reports it honestly.
  try {
    await migrateStore();
  } catch {
    /* unreachable — health() below reports the real state */
  }
  const health = await store.health();
  const durable = health.reachable && health.ready;
  return {
    ...base,
    durability: durable ? "persistent" : "ephemeral",
    durable,
    reachable: health.reachable,
    schemaReady: health.ready,
    schemaVersion: health.schemaVersion,
    reason: durable ? null : probeReason(store.kind, health),
  };
}

/** A minimal, non-sensitive store summary for callers that only need kind. */
export async function storeStatus(): Promise<Pick<StoreCapability, "kind" | "durability" | "durable">> {
  const cap = await storeCapability();
  return { kind: cap.kind, durability: cap.durability, durable: cap.durable };
}

/**
 * Guard for operations that genuinely require durable storage (referral
 * attribution). It returns a precise, honest refusal when the configured store
 * cannot persist across restarts, instead of silently writing to memory and
 * reporting a success that will vanish. Verifies the backend, so a URL alone is
 * never enough.
 */
export async function requireDurableStore(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cap = await storeCapability();
  if (cap.durable) return { ok: true };
  return { ok: false, reason: cap.reason ?? "Durable storage is unavailable." };
}

/**
 * Apply pending migrations to the configured backend. Safe to call on every boot
 * (idempotent). Returns the resulting schema version, or null when the backend
 * needs no explicit migration (memory/sqlite migrate on construction).
 */
export async function migrateStore(): Promise<number | null> {
  const store = getStore();
  if (store.kind === "postgres" && typeof (store as PostgresStore).migrate === "function") {
    await (store as PostgresStore).migrate();
    return SCHEMA_VERSION;
  }
  return null;
}
