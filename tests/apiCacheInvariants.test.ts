import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cache invariants.
 *
 * Two independent guards, because either one alone can be bypassed:
 *   1. the deployment sets `Cache-Control: no-store` on every `/api/*`
 *      response (next.config), so no API response can ever be stored by a
 *      shared cache;
 *   2. every live/priced/user-specific route also opts out at the route level
 *      (`force-dynamic`), so a future change to the header config cannot
 *      silently make a balance or a quote cacheable.
 *
 * A cached balance, quote, per-wallet gas capability or referral dashboard
 * would be a correctness or privacy bug.
 */
const SENSITIVE_ROUTES = [
  "app/api/quote/route.ts",
  "app/api/balances/route.ts",
  "app/api/optimize/route.ts",
  "app/api/partial/route.ts",
  "app/api/capabilities/route.ts",
  "app/api/tokens/route.ts",
  "app/api/nlp/route.ts",
  "app/api/diagnostics/route.ts",
  "app/api/referral/me/route.ts",
  "app/api/payments/attempts/route.ts",
  "app/api/payments/attempts/status/route.ts",
  "app/api/auth/session/route.ts",
];

const root = join(__dirname, "..");

describe("API cache invariants", () => {
  it("the deployment disables shared caching for all /api responses", () => {
    const config = readFileSync(join(root, "next.config.mjs"), "utf8");
    expect(config).toMatch(/\/api\/:path\*/);
    expect(config).toMatch(/Cache-Control/);
    expect(config).toMatch(/no-store/);
  });

  for (const rel of SENSITIVE_ROUTES) {
    it(`${rel} is force-dynamic`, () => {
      expect(existsSync(join(root, rel))).toBe(true);
      const src = readFileSync(join(root, rel), "utf8");
      expect(src).toMatch(/export const dynamic = "force-dynamic"/);
    });
  }
});
