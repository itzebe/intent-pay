import { schemaFor, encodeValue, decodeValue } from "./schema";
import { MIGRATIONS, snake, qi } from "./migrations";
import type { TableName, Store, StoreTables, StoreHealth } from "./types";
import { StoreConflictError, SCHEMA_VERSION } from "./types";

/**
 * A managed-Postgres adapter (Neon today), the only genuinely durable backend on
 * an ephemeral/serverless filesystem.
 *
 * It uses `@neondatabase/serverless`, whose `Pool` speaks the WebSocket proxy
 * protocol so a serverless function can use the ordinary `pg`-style API over a
 * pooled connection without a TCP socket. Every query is parameterized — the
 * identifiers come from the shared schema and are quoted; the *values* are always
 * bound. Nothing user-supplied is ever interpolated into SQL.
 *
 * Connection handling: a module-level pool is cached across warm invocations (a
 * cold start builds one). The pool is created lazily so importing this module
 * never throws when Postgres is not configured. `transaction()` checks out a
 * single client for the whole callback, so a multi-statement qualification is
 * atomic on one connection.
 *
 * Constraints (UNIQUE / CHECK / FOREIGN KEY) live in the database, not in
 * application code, so concurrent requests cannot create duplicate codes,
 * attributions or qualifications. A unique violation is translated into the
 * shared `StoreConflictError` so callers can apply the same "loser adopts the
 * winner" logic they use on every backend.
 */

/** The subset of a `pg`-style client the adapter needs. */
type PgQueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
type PgClient = {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  release(): void;
};
type PgPool = {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
};

/** Postgres error codes that mean a constraint was violated. */
const CONSTRAINT_CODES = new Set(["23505", "23503", "23514", "23P01"]);

function wrapError(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e?.code && CONSTRAINT_CODES.has(e.code)) {
    throw new StoreConflictError(e.constraint ? `${e.constraint}: ${e.message}` : (e.message ?? "constraint"));
  }
  throw err;
}

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  private pool: PgPool | null = null;
  private readonly connectionString: string;
  private migrated = false;

  constructor(connectionString: string) {
    if (!connectionString) throw new Error("A Postgres connection string is required.");
    this.connectionString = connectionString;
  }

  /** Lazily build the pooled client. Kept out of the constructor so import is safe. */
  private async getPool(): Promise<PgPool> {
    if (this.pool) return this.pool;
    // Assemble the specifier at runtime so a bundler never tries to inline it.
    const mod = (await import("@neondatabase/serverless")) as unknown as {
      Pool: new (config: { connectionString: string }) => PgPool;
    };
    this.pool = new mod.Pool({ connectionString: this.connectionString });
    return this.pool;
  }

  /**
   * Apply every pending migration. Idempotent and safe to call concurrently:
   * each migration is wrapped in a transaction and re-checked, and the DDL uses
   * `IF NOT EXISTS`, so two cold starts racing produce the same schema.
   */
  async migrate(): Promise<void> {
    if (this.migrated) return;
    const pool = await this.getPool();
    for (const migration of MIGRATIONS) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Probe the ledger WITHOUT issuing a query that fails. On a brand-new
        // database `_migrations` does not exist yet; a `SELECT ... FROM
        // "_migrations"` raises 42P01, and although the rejection is caught,
        // PostgreSQL has already aborted the transaction (25P02), so every later
        // statement in it is rejected and the schema is never created.
        // `to_regclass` returns NULL for a missing relation instead of erroring, so
        // the first migration can proceed.
        const ledger = await client.query("SELECT to_regclass($1) AS t", [qi("_migrations")]);
        const applied = ledger.rows[0]?.t
          ? await client.query(`SELECT ${qi("id")} FROM ${qi("_migrations")} WHERE ${qi("id")} = $1`, [migration.id])
          : { rows: [] as Record<string, unknown>[], rowCount: 0 };
        if (applied.rows.length === 0) {
          for (const statement of migration.statements) {
            await client.query(statement);
          }
          await client.query(
            `INSERT INTO ${qi("_migrations")} (${qi("id")}, ${qi("applied_at")}) VALUES ($1, $2) ON CONFLICT (${qi("id")}) DO NOTHING`,
            [migration.id, Date.now()],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw err;
      } finally {
        client.release();
      }
    }
    this.migrated = true;
  }

  private async query(text: string, values: unknown[]): Promise<PgQueryResult> {
    // Ensure the schema exists before the first real statement. Idempotent and
    // cheap after the first call, so a cold start self-heals without a separate
    // migration step.
    if (!this.migrated) await this.migrate();
    const runner = this.override ?? (await this.getPool());
    try {
      return await runner.query(text, values);
    } catch (err) {
      wrapError(err);
    }
  }

  private buildInsert(schema: ReturnType<typeof schemaFor>, row: Record<string, unknown>, conflict: boolean): {
    text: string;
    values: unknown[];
  } {
    const fields = schema.columns.map((c) => c.field).filter((f) => row[f] !== undefined);
    const cols = fields.map((f) => schema.columns.find((c) => c.field === f)!);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => encodeValue(c.type, row[c.field]));
    let text = `INSERT INTO ${qi(snake(schema.name))} (${cols.map((c) => qi(c.column)).join(", ")}) VALUES (${placeholders})`;
    if (conflict) {
      const pk = schema.primaryKeys.map((f) => qi(schema.columns.find((c) => c.field === f)!.column)).join(", ");
      const updates = cols.filter((c) => !schema.primaryKeys.includes(c.field)).map((c) => `${qi(c.column)} = EXCLUDED.${qi(c.column)}`);
      text += updates.length ? ` ON CONFLICT (${pk}) DO UPDATE SET ${updates.join(", ")}` : ` ON CONFLICT (${pk}) DO NOTHING`;
    }
    return { text, values };
  }

  private whereClause(
    schema: ReturnType<typeof schemaFor>,
    where: Record<string, unknown> | undefined,
  ): { sql: string; values: unknown[] } {
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v === undefined) continue;
      const def = schema.columns.find((c) => c.field === k);
      if (!def) continue;
      values.push(encodeValue(def.type, v));
      parts.push(`${qi(def.column)} = $${values.length}`);
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

  async insert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void> {
    const schema = schemaFor(table);
    const { text, values } = this.buildInsert(schema, row as Record<string, unknown>, false);
    await this.query(text, values);
  }

  async upsert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void> {
    const schema = schemaFor(table);
    const { text, values } = this.buildInsert(schema, row as Record<string, unknown>, true);
    await this.query(text, values);
  }

  async findOne<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<StoreTables[T] | undefined> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where as Record<string, unknown>);
    const res = await this.query(`SELECT * FROM ${qi(snake(table))} ${sql} LIMIT 1`, values);
    return res.rows[0] ? this.decodeRow<T>(schema, res.rows[0]) : undefined;
  }

  async findMany<T extends TableName>(
    table: T,
    where?: Partial<StoreTables[T]>,
    opts?: { limit?: number; orderBy?: keyof StoreTables[T]; dir?: "asc" | "desc" },
  ): Promise<StoreTables[T][]> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where as Record<string, unknown>);
    let order = "";
    if (opts?.orderBy) {
      const def = schema.columns.find((c) => c.field === opts.orderBy);
      if (def) order = `ORDER BY ${qi(def.column)} ${opts.dir === "asc" ? "ASC" : "DESC"}`;
    }
    const limit = opts?.limit !== undefined ? `LIMIT ${Math.max(0, Math.trunc(opts.limit))}` : "";
    const res = await this.query(`SELECT * FROM ${qi(snake(table))} ${sql} ${order} ${limit}`, values);
    return res.rows.map((r) => this.decodeRow<T>(schema, r));
  }

  async update<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
    patch: Partial<StoreTables[T]>,
  ): Promise<number> {
    const schema = schemaFor(table);
    const setParts: string[] = [];
    const setValues: unknown[] = [];
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      const def = schema.columns.find((c) => c.field === k);
      if (!def) continue;
      setValues.push(encodeValue(def.type, v));
      setParts.push(`${qi(def.column)} = $${setValues.length}`);
    }
    if (!setParts.length) return 0;
    const { sql, values } = this.whereClause(schema, where as Record<string, unknown>);
    const offset = setValues.length;
    const whereSql = sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
    const res = await this.query(`UPDATE ${qi(snake(table))} SET ${setParts.join(", ")} ${whereSql}`, [...setValues, ...values]);
    return res.rowCount ?? 0;
  }

  async remove<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<number> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where as Record<string, unknown>);
    const res = await this.query(`DELETE FROM ${qi(snake(table))} ${sql}`, values);
    return res.rowCount ?? 0;
  }

  async count<T extends TableName>(table: T, where?: Partial<StoreTables[T]>): Promise<number> {
    const schema = schemaFor(table);
    const { sql, values } = this.whereClause(schema, where as Record<string, unknown>);
    const res = await this.query(`SELECT COUNT(*)::int AS c FROM ${qi(snake(table))} ${sql}`, values);
    return Number(res.rows[0]?.c ?? 0);
  }

  /**
   * Run `fn` on a single checked-out client inside a transaction. Using one
   * client (not the pool) is what makes the statements atomic: a pool would
   * spread them across connections where BEGIN/COMMIT would not apply.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const pool = await this.getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.runOnClient(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      wrapError(err);
    } finally {
      client.release();
    }
  }

  /**
   * Execute `fn` with the adapter temporarily bound to a specific client, so a
   * transaction's statements all run on the same connection. The binding is
   * restored afterwards, which keeps concurrent (non-transactional) reads on the
   * pool.
   */
  private async runOnClient<T>(client: PgClient, fn: () => Promise<T>): Promise<T> {
    const prev = this.override;
    this.override = client;
    try {
      return await fn();
    } finally {
      this.override = prev;
    }
  }

  private override: PgClient | null = null;

  async health(): Promise<StoreHealth> {
    try {
      const pool = await this.getPool();
      await pool.query("SELECT 1");
      const res = await pool
        .query(`SELECT MAX(${qi("id")}) AS v FROM ${qi("_migrations")}`)
        .catch(() => ({ rows: [] as Record<string, unknown>[], rowCount: 0 }));
      const raw = res.rows[0]?.v;
      const version = raw === null || raw === undefined ? null : Number(raw);
      return { reachable: true, ready: version !== null && version >= SCHEMA_VERSION, schemaVersion: version };
    } catch (err) {
      return { reachable: false, ready: false, schemaVersion: null, error: (err as Error)?.message?.slice(0, 200) };
    }
  }

  async reset(): Promise<void> {
    const { SCHEMA } = await import("./schema");
    for (const schema of SCHEMA) {
      await this.query(`DELETE FROM ${qi(snake(schema.name))}`, []);
    }
  }
}
