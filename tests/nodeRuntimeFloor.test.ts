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
 * The Node.js runtime floor is a security control, not metadata.
 *
 * CVE-2026-111497 is a Brotli decoder out-of-bounds write that permits remote
 * code execution (HIGH). It affects every Node.js 22.x / 24.x / 26.x release
 * before v22.23.4 / v24.22.1 / v26.12.1. The declared `engines.node` must keep
 * rejecting those releases, and the first patched 24.x release must satisfy it.
 *
 * Node does NOT bump the bundled brotli version string for this fix (v24.22.1
 * still reports BROTLI_VERSION 1.2.0), so the Node.js version — not
 * `process.versions.brotli` — is the thing to assert.
 */
describe("Node.js runtime floor (CVE-2026-111497)", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;

  it("declares an engines.node range", () => {
    expect(typeof range).toBe("string");
    expect(range!.length).toBeGreaterThan(0);
  });

  it("rejects the vulnerable Node.js 24.x releases", () => {
    for (const v of ["24.21.0", "24.22.0", "24.20.0"]) {
      expect(semver.satisfies(v, range!), `${v} must be rejected`).toBe(false);
    }
  });

  it("accepts the first patched 24.x release and later ones", () => {
    for (const v of ["24.22.1", "24.22.5", "24.23.0"]) {
      expect(semver.satisfies(v, range!), `${v} must be accepted`).toBe(true);
    }
  });

  it("does not silently widen to an unpatched major line", () => {
    // 22.x / 26.x are patched at different patch levels; this project is pinned
    // to the 24.x line, so neither should satisfy the range by accident.
    for (const v of ["22.23.4", "26.12.1", "23.11.0", "25.0.0"]) {
      expect(semver.satisfies(v, range!), `${v} must be rejected`).toBe(false);
    }
  });
});
