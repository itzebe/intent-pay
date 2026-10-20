import { schemaFor, columnForField } from "./schema";
import type { TableName, Store, StoreTables, StoreHealth } from "./types";
import { StoreConflictError, SCHEMA_VERSION } from "./types";

export type { TableName, Store, StoreTables };
export { StoreConflictError };

/**
 * A pure, in-memory store with the SAME integrity rules as the SQLite adapter.
 *
 * It exists so unit tests can exercise the real attribution/qualification logic
 * (including unique-constraint collisions and transactions) without touching a
 * file or a database. Because the uniqueness rules are read from the shared
 * schema, a test that passes here reflects the production constraints rather
 * than a weaker approximation.
 */

type Row = Record<string, unknown>;

function match(row: Row, where: Partial<Row> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (row[k] !== v) return false;
  }
  return true;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private tables = new Map<TableName, Row[]>();
  /** When > 0 we are inside a transaction; mutations buffer for rollback. */
  private depth = 0;
  private undo: Array<() => void> = [];
  /** Serializes transactions (see transaction()). */
  private txChain: Promise<void> = Promise.resolve();

  private rows(table: TableName): Row[] {
    let r = this.tables.get(table);
    if (!r) {
      r = [];
      this.tables.set(table, r);
    }
    return r;
  }

  private clone(row: Row): Row {
    return { ...row };
  }

  /** Enforce the schema's unique groups for a prospective row. */
  private assertUnique(table: TableName, candidate: Row, ignore?: Row): void {
    const schema = schemaFor(table);
    const rows = this.rows(table);
    for (const group of schema.uniqueGroups) {
      // A group containing any NULL value never collides (SQL semantics).
      if (group.some((f) => candidate[f] === null || candidate[f] === undefined)) continue;
      for (const existing of rows) {
        if (existing === ignore) continue;
        if (group.every((f) => existing[f] === candidate[f])) {
          throw new StoreConflictError(
            `${table}: duplicate ${group.join("+")} = ${group.map((f) => candidate[f]).join("/")}`,
          );
        }
      }
    }
    // Enforce the composite primary key too.
    const pk = schema.primaryKeys;
    if (!pk.some((f) => candidate[f] === null || candidate[f] === undefined)) {
      for (const existing of rows) {
        if (existing === ignore) continue;
        if (pk.every((f) => existing[f] === candidate[f])) {
          throw new StoreConflictError(`${table}: duplicate primary key`);
        }
      }
    }
  }

  async insert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void> {
    const candidate = this.clone(row as Row);
    this.assertUnique(table, candidate);
    this.rows(table).push(candidate);
    if (this.depth > 0) {
      const rows = this.rows(table);
      this.undo.push(() => {
        const idx = rows.indexOf(candidate);
        if (idx >= 0) rows.splice(idx, 1);
      });
    }
  }

  async upsert<T extends TableName>(table: T, row: StoreTables[T]): Promise<void> {
    const schema = schemaFor(table);
    const candidate = this.clone(row as Row);
    const pk = schema.primaryKeys;
    const existing = this.rows(table).find((r) => pk.every((f) => r[f] === candidate[f]));
    if (existing) {
      const before = this.clone(existing);
      Object.assign(existing, candidate);
      this.assertUnique(table, existing, existing);
      if (this.depth > 0) this.undo.push(() => Object.assign(existing, before));
    } else {
      await this.insert(table, row);
    }
  }

  async findOne<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<StoreTables[T] | undefined> {
    const found = this.rows(table).find((r) => match(r, where as Row));
    return found ? (this.clone(found) as StoreTables[T]) : undefined;
  }

  async findMany<T extends TableName>(
    table: T,
    where?: Partial<StoreTables[T]>,
    opts?: { limit?: number; orderBy?: keyof StoreTables[T]; dir?: "asc" | "desc" },
  ): Promise<StoreTables[T][]> {
    let rows = this.rows(table).filter((r) => match(r, where as Row | undefined));
    if (opts?.orderBy) {
      const key = opts.orderBy as string;
      const dir = opts.dir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[key] as number | string | null;
        const bv = b[key] as number | string | null;
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return av > bv ? dir : -dir;
      });
    }
    if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map((r) => this.clone(r) as StoreTables[T]);
  }

  async update<T extends TableName>(
    table: T,
    where: Partial<StoreTables[T]>,
    patch: Partial<StoreTables[T]>,
  ): Promise<number> {
    const schema = schemaFor(table);
    let changed = 0;
    for (const row of this.rows(table)) {
      if (!match(row, where as Row)) continue;
      // Only apply known columns.
      const next: Row = { ...row };
      for (const [k, v] of Object.entries(patch as Row)) {
        if (columnForField(schema, k)) next[k] = v;
      }
      const before = this.clone(row);
      Object.assign(row, next);
      this.assertUnique(table, row, row);
      changed++;
      if (this.depth > 0) this.undo.push(() => Object.assign(row, before));
    }
    return changed;
  }

  async remove<T extends TableName>(table: T, where: Partial<StoreTables[T]>): Promise<number> {
    const rows = this.rows(table);
    const keep: Row[] = [];
    let removed = 0;
    for (const row of rows) {
      if (match(row, where as Row)) {
        removed++;
        if (this.depth > 0) {
          const copy = this.clone(row);
          this.undo.push(() => rows.push(copy));
        }
      } else {
        keep.push(row);
      }
    }
    rows.length = 0;
    rows.push(...keep);
    return removed;
  }

  async count<T extends TableName>(table: T, where?: Partial<StoreTables[T]>): Promise<number> {
    return this.rows(table).filter((r) => match(r, where as Row | undefined)).length;
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.depth++;
      const mark = this.undo.length;
      try {
        const result = await fn();
        this.depth--;
        if (this.depth === 0) this.undo = [];
        return result;
      } catch (err) {
        // Roll back every buffered mutation, newest first.
        for (let i = this.undo.length - 1; i >= mark; i--) this.undo[i]();
        this.undo.length = mark;
        this.depth--;
        throw err;
      }
    };
    const result = this.txChain.then(run, run);
    this.txChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async reset(): Promise<void> {
    this.tables.clear();
    this.undo = [];
    this.depth = 0;
  }

  /** Memory is always reachable, and its schema is always at the current version. */
  async health(): Promise<StoreHealth> {
    return { reachable: true, ready: true, schemaVersion: SCHEMA_VERSION };
  }
}
