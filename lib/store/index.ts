import type { Store } from "./types";
import { MemoryStore } from "./memory";
import { SqliteStore } from "./sqlite";

export type { Store, TableName, StoreTables } from "./types";
export { MemoryStore, StoreConflictError } from "./memory";
export { SqliteStore } from "./sqlite";

/**
 * The process-wide store.
 *
 * Production uses the SQLite adapter (real constraints, real transactions) at
 * `INTENT_PAY_DB_PATH`. Tests and runtimes without `node:sqlite` fall back to the
 * pure in-memory adapter, which enforces the identical uniqueness rules.
 *
 * The fallback is explicit and honest rather than a silent success: the store
 * kind is reported through `/api/capabilities` so the UI never claims durable
 * persistence it does not have.
 */
let singleton: Store | null = null;

/** The default on-disk database path. */
export function defaultDbPath(): string {
  if (process.env.INTENT_PAY_DB_PATH) return process.env.INTENT_PAY_DB_PATH;
  // Prefer a writable temp location so a read-only deploy root never crashes.
  const base = process.env.TMPDIR || process.env.TEMP || "/tmp";
  return `${base.replace(/\/$/, "")}/intent-pay.sqlite`;
}

function createStore(): Store {
  if (process.env.INTENT_PAY_STORE === "memory") return new MemoryStore();
  try {
    return new SqliteStore(defaultDbPath());
  } catch {
    // `node:sqlite` unavailable (older Node, edge runtime) — degrade honestly.
    return new MemoryStore();
  }
}

export function getStore(): Store {
  if (!singleton) singleton = createStore();
  return singleton;
}

/** Replace the process store — tests only. */
export function setStore(store: Store | null): void {
  singleton = store;
}

/** The store kind actually in use (for honest capability reporting). */
export function storeKind(): "sqlite" | "memory" {
  return getStore().kind;
}
