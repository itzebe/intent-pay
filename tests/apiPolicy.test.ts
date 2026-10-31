import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Secure-by-default API policy.
 *
 * Every route under `app/api` that does real work must apply an abuse control.
 * The categories are explicit so a *new* route cannot silently ship without one:
 *
 *   - `RATE_LIMITED`  — the route (or a helper it delegates to) calls
 *                       `enforceRateLimit`/`rateLimit`. This covers the paid or
 *                       amplification surfaces: quote, balances, tokens, optimize,
 *                       partial, nlp, the referral writes, auth and payments.
 *   - `ADMIN_GATED`   — the route requires `adminAuthorized` (ops, diagnostics).
 *   - `TRIVIAL`       — a cheap, read-only, non-amplifying endpoint (health,
 *                       capabilities, referral availability) that is safe to
 *                       leave open. Adding a route here is a deliberate decision,
 *                       not a default.
 *
 * If this test fails, a new route was added without an explicit classification.
 * Do not "fix" it by loosening the assertion — apply the control or add the route
 * to `TRIVIAL` with a reason.
 */
const root = join(__dirname, "..", "app", "api");

const ADMIN_GATED = new Set(["ops/cost", "ops/errors", "diagnostics"]);

const TRIVIAL = new Set([
  // Static liveness read; no provider fan-out, no user data.
  "health",
]);

function apiRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs, rel ? `${rel}/${entry}` : entry);
      } else if (entry === "route.ts") {
        routes.push(rel);
      }
    }
  };
  walk(root, "");
  return routes.sort();
}

describe("secure-by-default API policy", () => {
  const routes = apiRoutes();

  it("enumerates every API route", () => {
    expect(routes.length).toBeGreaterThan(15);
  });

  for (const rel of routes) {
    const src = readFileSync(join(root, rel, "route.ts"), "utf8");
    const hasRateLimit = /enforceRateLimit|rateLimit\(/.test(src);
    const hasAdmin = /adminAuthorized/.test(src);

    it(`${rel} applies an abuse control`, () => {
      if (TRIVIAL.has(rel)) {
        // A trivial route must genuinely be trivial: no rate limit needed, but
        // also no accidental provider fan-out sneaking in.
        expect(hasRateLimit || hasAdmin).toBe(false);
        return;
      }
      if (ADMIN_GATED.has(rel)) {
        expect(hasAdmin).toBe(true);
        return;
      }
      expect(hasRateLimit).toBe(true);
    });
  }
});
