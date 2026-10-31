import { getStore } from "@/lib/store";
import type { StoreTables } from "@/lib/store/types";
import { HELD_PREFIX, SPENT_PREFIX } from "@/lib/server/aiBudgetKeys";

/**
 * Opportunistic maintenance of the shared tables.
 *
 * Three kinds of row grow without bound on a serverless deployment that has no
 * cron to sweep them:
 *   - rate-limit counters (`rl:<bucket>:<subject>:<window>`), dead as soon as
 *     their window has passed;
 *   - login nonces (`nonce:<id>`), single-use and expiring after a few minutes
 *     but only removed when actually consumed;
 *   - operational telemetry (`opsEvents`) and payment-attempt correlation rows
 *     (`paymentAttempts`), which are append-only and are only ever read back
 *     over a recent window (the ops view clamps to 30 days).
 *
 * A serverless deployment has no cron, so the sweep runs inline, fire-and-forget,
 * at most once per `SWEEP_INTERVAL_MS`, triggered from the rate limiter. It is
 * best-effort: a failure is swallowed (the limiter is not a correctness path) and
 * the next trigger retries. The `session_secret` and `costs` rows are never
 * touched — only the known ephemeral prefixes and the two append-only tables.
 *
 * The sweep is bounded: every read uses a `LIMIT` and the oldest-first order, so
 * a large table cannot turn the maintenance pass itself into a memory or latency
 * spike. A table larger than one batch is drained over successive sweeps.
 */

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** A rate-limit key older than this can no longer be in its window (max 60s). */
const RATE_LIMIT_MAX_AGE_MS = 60 * 60 * 1000;
/** Telemetry older than this is no longer surfaced by the ops view. */
const OPS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Correlation rows older than this are no longer useful for reconciliation. */
const ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Rows examined per table per sweep, so a huge table cannot spike memory. */
const SWEEP_BATCH = 2_000;

let lastSweep = 0;

export function sweepExpiredKv(now = Date.now()): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  void runSweep(now).catch(() => {
    /* best-effort maintenance; never surface a maintenance failure */
  });
}

async function runSweep(now: number): Promise<void> {
  const store = getStore();

  // kv — a bounded page of the oldest-touched rows.
  const kvRows = await store.findMany("kv", undefined, {
    orderBy: "updatedAt",
    dir: "asc",
    limit: SWEEP_BATCH,
  });
  for (const row of kvRows) {
    if (row.key.startsWith("rl:")) {
      if (now - row.updatedAt > RATE_LIMIT_MAX_AGE_MS) {
        await store.remove("kv", { key: row.key });
      }
      continue;
    }
    if (row.key.startsWith("nonce:")) {
      try {
        const parsed = JSON.parse(row.value) as { exp?: number };
        if (typeof parsed.exp === "number" && parsed.exp < now) {
          await store.remove("kv", { key: row.key });
        }
      } catch {
        // A malformed nonce row is unusable; drop it.
        await store.remove("kv", { key: row.key });
      }
    }
  }

  // Append-only tables, pruned by age so they cannot grow forever.
  await pruneOlderThan("opsEvents", "at", now - OPS_RETENTION_MS);
  await pruneOlderThan("paymentAttempts", "createdAt", now - ATTEMPT_RETENTION_MS);

  // Dead rate-limit windows (the `counters` table). A window key older than the
  // max window can never be hit again. The monthly AI-spend counter (`aib:spent:*`)
  // is excluded — it must survive until the month rolls or a sweep would reset the
  // budget. The per-window AI reservations (`aib:held:*`) are swept when dead.
  const counterRows = await store.findMany("counters", undefined, {
    orderBy: "updatedAt",
    dir: "asc",
    limit: SWEEP_BATCH,
  });
  for (const row of counterRows) {
    if (row.key.startsWith(SPENT_PREFIX)) continue;
    if (row.key.startsWith(HELD_PREFIX)) {
      if (now - row.updatedAt > RATE_LIMIT_MAX_AGE_MS) await store.remove("counters", { key: row.key });
      continue;
    }
    if (now - row.updatedAt > RATE_LIMIT_MAX_AGE_MS) {
      await store.remove("counters", { key: row.key });
    } else {
      break; // ascending: the rest are fresh
    }
  }
}

async function pruneOlderThan<T extends "opsEvents" | "paymentAttempts">(
  table: T,
  field: keyof StoreTables[T] & ("at" | "createdAt"),
  cutoff: number,
): Promise<void> {
  const store = getStore();
  const rows = await store.findMany(table, undefined, {
    orderBy: field,
    dir: "asc",
    limit: SWEEP_BATCH,
  });
  for (const row of rows) {
    const at = Number((row as Record<string, unknown>)[field]);
    if (Number.isFinite(at) && at >= cutoff) break; // ascending: the rest are fresh
    await store.remove(table, { id: (row as { id: string }).id } as Partial<StoreTables[T]>);
  }
}
