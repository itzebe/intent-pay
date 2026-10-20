import { createRequire } from "node:module";
import { schemaFor, encodeValue, decodeValue } from "./schema";
import { SCHEMA } from "./schema";
import type { TableName, Store, StoreTables, StoreHealth } from "./types";
import { StoreConflictError, SCHEMA_VERSION } from "./types";

export type { TableName, Store, StoreTables };

/**
 * Load Node's built-in SQLite without letting a bundler rewrite the specifier.
 *
 * Vite/webpack strip the `node:` prefix and then fail to resolve `sqlite`, so the
 * module id is assembled at runtime and required through `createRequire`. This
 * keeps `node:sqlite` out of every bundle while remaining a real builtin at
 * runtime.
 */
type DatabaseSyncCtor = new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

let cachedCtor: DatabaseSyncCtor | null = null;
function loadDatabaseSync(): DatabaseSyncCtor {
  if (cachedCtor) return cachedCtor;
  const req = createRequire(import.meta.url);
  const spec = ["node", "sqlite"].join(":");
  const mod = req(spec) as { DatabaseSync: DatabaseSyncCtor };
  cachedCtor = mod.DatabaseSync;
  return cachedCtor;
}

/**
 * The SQLite adapter, built on Node's built-in `node:sqlite`.
 *
 * This is a real relational database: UNIQUE constraints, CHECK constraints,
 * FOREIGN KEYs and transactions are enforced by the engine, not by application
 * code. That is what makes the referral guarantees (unique codes, one referrer
 * per referred wallet, one qualifying transaction per referral) hold even under
 * concurrency, rather than relying on a best-effort read-then-write.
 *
 * The database file path comes from `INTENT_PAY_DB_PATH` (defaults to a file in
 * the OS temp dir so a misconfigured deploy never crashes; an in-memory mode is
 * available for read-only/edge runtimes where a filesystem may be absent).
 *
 * Note on durability: on an ephemeral serverless filesystem the file may not
 * survive a cold start. The application treats the store as best-effort and
 * reports honestly when it is unavailable; it never fabricates records. A
 * managed database is a drop-in replacement behind the same `Store` interface.
 */

/** Translate a SQLite constraint failure into the shared conflict error. */
function wrapError(err: unknown): never {
  const e = err as { code?: string; message?: string };
  const message = e?.message ?? String(err);
  if (
    e?.code === "ERR_SQLITE_ERROR" &&
    /UNIQUE|PRIMARY KEY|CHECK|FOREIGN KEY|constraint/i.test(message)
  ) {
    throw new StoreConflictError(message);
  }
  throw err;
}

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private db: InstanceType<DatabaseSyncCtor>;
  /** Serializes transactions (see transaction()). */
  private txChain: Promise<void> = Promise.resolve();

  constructor(path = ":memory:") {
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  /**
   * Create every table if it does not already exist (idempotent migration).
   *
   * The applied version is recorded in a `_migrations` ledger so `health()` can
   * prove the schema is present, not merely that a file opened.
   */
  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);");
    for (const schema of SCHEMA) {
      const cols = schema.columns
        .map((c) => `${c.column} ${c.type === "int" ? "INTEGER" : c.type === "bool" ? "INTEGER" : "TEXT"}${c.nullable ? "" : " NOT NULL"}`)
        .join(", ");
      const pk = `PRIMARY KEY (${schema.primaryKeys.map((f) => schema.columns.find((c) => c.field === f)!.column).join(", ")})`;
      const unique = schema.uniqueGroups
        .map((g) => `UNIQUE (${g.map((f) => schema.columns.find((c) => c.field === f)!.column).join(", ")})`)
        .join(", ");
      const checks = (schema.checks ?? []).map((c) => `CHECK (${c})`).join(", ");
      const fks = (schema.foreignKeys ?? []).join(", ");
      const extras = [pk, unique, checks, fks].filter(Boolean).join(", ");
      const table = snake(schema.name);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${cols}, ${extras});`);
    }
    this.db.exec(`INSERT OR IGNORE INTO _migrations (id, applied_at) VALUES (${SCHEMA_VERSION}, ${Date.now()});`);
  }

  async insert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void> {
    const schema = schemaFor(table);
    const fields = schema.columns.map((c) => c.field).filter((f) => (row as Record<string, unknown>)[f] !== undefined);
    const cols = fields.map((f) => schema.columns.find((c) => c.field === f)!.column);
    const placeholders = fields.map(() => "?").join(", ");
    const values = fields.map((f) => {
      const def = schema.columns.find((c) => c.field === f)!;
      return encodeValue(def.type, (row as Record<string, unknown>)[f]);
    });
    try {
      this.db
        .prepare(`INSERT INTO ${snake(table)} (${cols.join(", ")}) VALUES (${placeholders})`)
        .run(...(values as (string | number | null)[]));
    } catch (err) {
      wrapError(err);
    }
  }

  async upsert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void> {
    const schema = schemaFor(table);
    const fields = schema.columns.map((c) => c.field).filter((f) => (row as Record<string, unknown>)[f] !== undefined);
    const cols = fields.map((f) => schema.columns.find((c) => c.field === f)!.column);
    const placeholders = fields.map(() => "?").join(", ");
    const values = fields.map((f) => {
      const def = schema.columns.find((c) => c.field === f)!;
      return encodeValue(def.type, (row as Record<string, unknown>)[f]);
    });
    const updates = cols.filter((c) => !schema.primaryKeys.includes(c)).map((c) => `${c}=excluded.${c}`);
    const onConflict = updates.length
      ? `ON CONFLICT (${schema.primaryKeys.map((f) => schema.columns.find((c) => c.field === f)!.column).join(", ")}) DO UPDATE SET ${updates.join(", ")}`
      : `ON CONFLICT DO NOTHING`;
    try {
      this.db
        .prepare(`INSERT INTO ${snake(table)} (${cols.join(", ")}) VALUES (${placeholders}) ${onConflict}`)
        .run(...(values as (string | number | null)[]));
    } catch (err) {
      wrapError(err);
    }
  }

  private whereClause<T extends TableName>(
    schema: ReturnType<typeof schemaFor>,
    where: Partial<StoreTables[T]> | undefined,
  ): { sql: string; values: (string | number | null)[] } {
    const parts: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v === undefined) continue;
      const def = schema.columns.find((c) => c.field === k);
      if (!def) continue;
      parts.push(`${def.column} = ?`);
      values.push(encodeValue(def.type, v));
    }
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", values };
  }

  private decodeRow<T extends TableName>(schema: ReturnType<typeof schemaFor>, row: Record<string, unknown>): StoreTables[T] {
    const out: Record<string, unknown> = {};
    for (const col of schema.columns) {
      out[col.field] = decodeValue(col.type, row[col.column]);
    }
    return out as StoreTables[T];
  }

  async findOne<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<StoreTables[T] | undefined> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where);
    const row = this.db
      .prepare(`SELECT * FROM ${snake(table)} ${sql} LIMIT 1`)
      .get(...(values as (string | number | null)[])) as Record<string, unknown> | undefined;
    return row ? this.decodeRow<T>(schema, row) : undefined;
  }

  async findMany<T extends TableName>(
    table: T,
    where?: Partial<StoreTables[T]>,
    opts?: { limit?: number; orderBy?: keyof StoreTables[T]; dir?: "asc" | "desc" },
  ): Promise<StoreTables[T][]> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where);
    let order = "";
    if (opts?.orderBy) {
      const def = schema.columns.find((c) => c.field === opts.orderBy);
      if (def) order = `ORDER BY ${def.column} ${opts.dir === "asc" ? "ASC" : "DESC"}`;
    }
    const limit = opts?.limit !== undefined ? `LIMIT ${Math.max(0, Math.trunc(opts.limit))}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM ${snake(table)} ${sql} ${order} ${limit}`)
      .all(...(values as (string | number | null)[])) as Record<string, unknown>[];
    return rows.map((r) => this.decodeRow<T>(schema, r));
  }

  async update<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
    patch: Partial<StoreTables[T]>,
  ): Promise<number> {
    const schema = schemaFor(table);
    const setParts: string[] = [];
    const setValues: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const def = schema.columns.find((c) => c.field === k);
      if (!def) continue;
      setParts.push(`${def.column} = ?`);
      setValues.push(encodeValue(def.type, v));
    }
    if (!setParts.length) return 0;
    const { sql, values } = this.whereClause(schema, where);
    try {
      const info = this.db
        .prepare(`UPDATE ${snake(table)} SET ${setParts.join(", ")} ${sql}`)
        .run(...([...setValues, ...values] as (string | number | null)[]));
      return Number(info.changes ?? 0);
    } catch (err) {
      wrapError(err);
    }
  }

  async remove<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<number> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where);
    const info = this.db
      .prepare(`DELETE FROM ${snake(table)} ${sql}`)
      .run(...(values as (string | number | null)[]));
    return Number(info.changes ?? 0);
  }

  async count<T extends TableName>(table: T, where?: Partial<StoreTables[T]>): Promise<number> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM ${snake(table)} ${sql}`)
      .get(...(values as (string | number | null)[])) as { c: number } | undefined;
    return Number(row?.c ?? 0);
  }

  /**
   * Run `fn` inside a transaction. Transactions are serialized on a promise
   * chain: `node:sqlite` uses a single connection, and because an async
   * transaction body yields the event loop, two concurrent transactions would
   * otherwise both issue `BEGIN` on the same connection ("cannot start a
   * transaction within a transaction"). Queueing preserves SQLite's single-writer
   * semantics and gives each transaction the isolation a database-backed one has.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec("BEGIN");
      try {
        const result = await fn();
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    };
    const result = this.txChain.then(run, run);
    // Keep the chain alive without leaking a rejection into it.
    this.txChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async reset(): Promise<void> {
    for (const schema of SCHEMA) {
      this.db.exec(`DELETE FROM ${snake(schema.name)};`);
    }
  }

  /** The file opened and every table exists — reachable and ready at the current version. */
  async health(): Promise<StoreHealth> {
    try {
      const row = this.db.prepare("SELECT MAX(id) AS v FROM _migrations").get() as { v: number | null } | undefined;
      const version = row?.v ?? null;
      return { reachable: true, ready: version !== null && version >= SCHEMA_VERSION, schemaVersion: version };
    } catch (err) {
      return { reachable: false, ready: false, schemaVersion: null, error: (err as Error)?.message?.slice(0, 200) };
    }
  }
}

/** camelCase table name -> snake_case (referralCodes -> referral_codes). */
function snake(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}
