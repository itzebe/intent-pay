import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * `semver` is only a transitive dependency (no `@types/semver` in the tree), so
 * it is loaded through `createRequire` with an explicit shape rather than
 * pulling a new devDependency in for one test.
 */
const require_ = createRequire(import.meta.url);
const semver = require_("semver") as { satisfies: (version: string, range: string) => boolean };

const root = join(__dirname, "..");

/**
 * The zod override is a security control, not a version preference.
 *
 * GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404 (HIGH, CWE-770): zod through 4.6.5 lets
 * an attacker exhaust memory by parsing a large unconstrained array. It is
 * patched only in 4.6.6+; there is no patched 3.x. The vulnerable
 * `$ZodArray.handleArrayResult` code is zod-v4-only, and no upstream consumer
 * (appkit, cdp-sdk, abitype) yet ships a fixed release, so the range is forced
 * through `overrides.zod` — every copy in the tree is deduped to one patched
 * zod.
 *
 * The first patched release must satisfy the declared range; a vulnerable
 * release must not.
 */
describe("zod dependency override (GHSA-mrhx-c7xc-m3w5)", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    overrides?: Record<string, string>;
  };
  const range = pkg.overrides?.zod;

  it("declares an overrides.zod range", () => {
    expect(typeof range).toBe("string");
    expect(range!.length).toBeGreaterThan(0);
  });

  it("rejects the vulnerable zod releases", () => {
    for (const v of ["3.22.4", "3.25.76", "4.6.5", "4.6.0"]) {
      expect(semver.satisfies(v, range!), `${v} must be rejected`).toBe(false);
    }
  });

  it("accepts the first patched release and later ones", () => {
    for (const v of ["4.6.6", "4.6.7", "4.7.0"]) {
      expect(semver.satisfies(v, range!), `${v} must be accepted`).toBe(true);
    }
  });

  it("resolves a single installed zod that satisfies the override", () => {
    const installed = JSON.parse(
      readFileSync(require_.resolve("zod/package.json"), "utf8"),
    ) as { version: string };
    expect(
      semver.satisfies(installed.version, range!),
      `installed zod ${installed.version} must satisfy ${range}`,
    ).toBe(true);
  });
});
