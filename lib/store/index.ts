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
 * Durability is NOT the same as "a database file exists". On an ephemeral
 * serverless filesystem the default SQLite file (in the OS temp dir) does not
 * survive a cold start, and the in-memory fallback does not survive anything.
 * `storeStatus()` reports this honestly and the referral feature refuses to
 * claim durable attribution it cannot deliver; the store kind is also surfaced
 * through `/api/capabilities`. The store never fabricates a record and never
 * silently reports ephemeral storage as persistent.
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

/**
 * How durable the store actually is — the honest answer, not the hopeful one.
 *
 *   - "memory"      — in-memory only; nothing survives a process restart.
 *   - "ephemeral"   — an on-disk SQLite file in an ephemeral location (the
 *                     default OS temp dir). Real constraints, but the file does
 *                     not survive a serverless cold start or a redeploy.
 *   - "persistent"  — an on-disk SQLite file at an explicitly configured path.
 *                     This is the only configuration the app will describe as
 *                     durable; whether the underlying volume is truly durable is
 *                     the operator's responsibility (a managed database behind
 *                     the same `Store` interface is a drop-in replacement).
 *
 * Nothing sensitive (no path, no credential) is returned here.
 */
export function storeDurability(): "memory" | "ephemeral" | "persistent" {
  if (getStore().kind === "memory") return "memory";
  return process.env.INTENT_PAY_DB_PATH ? "persistent" : "ephemeral";
}

/** A safe, non-sensitive summary of the store for the capabilities surface. */
export function storeStatus(): {
  kind: "sqlite" | "memory";
  durability: "memory" | "ephemeral" | "persistent";
  durable: boolean;
} {
  const durability = storeDurability();
  return { kind: storeKind(), durability, durable: durability === "persistent" };
}

/**
 * Guard for operations that genuinely require durable storage (referral
 * attribution). It returns a precise, honest refusal when the configured store
 * cannot persist across restarts, instead of silently writing to memory and
 * reporting a success that will vanish.
 */
export function requireDurableStore(): { ok: true } | { ok: false; reason: string } {
  const status = storeStatus();
  if (status.durable) return { ok: true };
  const reason =
    status.durability === "memory"
      ? "Referral attribution needs durable storage, but this deployment is running with an in-memory store. No referral data will be saved."
      : "Referral attribution needs durable storage, but this deployment stores data in an ephemeral filesystem that is erased on restart. Set INTENT_PAY_DB_PATH to a persistent volume to enable durable referrals.";
  return { ok: false, reason };
}
