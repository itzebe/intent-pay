import { describe, expect, it } from "vitest";
import { MIGRATIONS, LATEST_MIGRATION, snake, qi } from "@/lib/store/migrations";
import { SCHEMA_VERSION } from "@/lib/store/types";
import { SCHEMA } from "@/lib/store/schema";

/**
 * Versioned Postgres migrations.
 *
 * The migration SQL is derived from the shared schema, so it must (a) be
 * versioned and consistent with `SCHEMA_VERSION`, (b) create every table the
 * application reads and writes, and (c) carry the integrity constraints the
 * referral guarantees depend on. Identifiers are quoted; values are never
 * interpolated into the DDL.
 */
describe("postgres migrations", () => {
  const all = MIGRATIONS.flatMap((m) => m.statements).join("\n");

  it("is versioned and consistent with the declared schema version", () => {
    expect(LATEST_MIGRATION).toBe(SCHEMA_VERSION);
    expect(MIGRATIONS[0].id).toBe(1);
  });

  it("creates a migration ledger", () => {
    expect(all).toContain("CREATE TABLE IF NOT EXISTS");
    expect(all).toContain("_migrations");
  });

  it("creates every store table", () => {
    for (const schema of SCHEMA) {
      expect(all).toContain(`CREATE TABLE IF NOT EXISTS "${snake(schema.name)}"`);
    }
  });

  it("enforces the referral uniqueness constraints", () => {
    // One code per wallet.
    expect(all).toContain('UNIQUE ("owner")');
    // A referred wallet is attributed once; a tx qualifies once; a click dedups.
    expect(all).toContain('UNIQUE ("referred")');
    expect(all).toContain('UNIQUE ("qualified_tx_hash")');
    expect(all).toContain('UNIQUE ("click_key")');
    // One payment attempt per idempotency key.
    expect(all).toContain('UNIQUE ("idempotency_key")');
  });

  it("constrains the referral state to the known values", () => {
    expect(all).toContain("CHECK (state IN (");
    for (const state of ["clicked", "attributed", "qualified", "rejected"]) {
      expect(all).toContain(`'${state}'`);
    }
  });

  it("adds indexes for the real read patterns", () => {
    expect(all).toContain("idx_ops_events_at");
    expect(all).toContain("idx_referrals_referrer");
  });

  it("quotes identifiers safely", () => {
    expect(qi("state")).toBe('"state"');
    expect(qi('we"ird')).toBe('"we""ird"');
    expect(snake("referralCodes")).toBe("referral_codes");
    expect(snake("opsEvents")).toBe("ops_events");
  });
});
