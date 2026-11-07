import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ROUTES } from "@/lib/config/site";

/**
 * Developer-onboarding truthfulness.
 *
 * The SDK is developed in this repository and is **not published to npm**. Several
 * documents used to tell an integrator to run `npm install @intentpay/sdk`, which
 * fails with a 404 — a dead first step in the onboarding path. These tests pin the
 * honest instructions (build from source, install the tarball) and fail if an
 * unqualified npm install ever returns.
 */

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const DOCS_WITH_INSTALL = [
  "packages/sdk/README.md",
  "docs/developers.md",
  "app/docs/api/page.tsx",
  "app/developers/page.tsx",
  "app/docs/quickstart/page.tsx",
] as const;

describe("SDK install instructions are truthful", () => {
  it("never presents `npm install @intentpay/sdk` as a working command", () => {
    for (const file of DOCS_WITH_INSTALL) {
      const source = read(file);
      // The package is unpublished; an install line for it must not stand alone.
      // It is allowed only as a forward-looking note (the word "published" nearby).
      const lines = source.split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/npm install @intentpay\/sdk/.test(line)) continue;
        const context = lines.slice(Math.max(0, i - 3), i + 3).join(" ");
        expect(
          /publish|not yet|replaces the build step/i.test(context),
          `${file}:${i + 1} presents an unpublished package as installable: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  it("documents the build-from-source path everywhere the SDK is installed", () => {
    for (const file of DOCS_WITH_INSTALL) {
      const source = read(file);
      expect(
        /npm run build[\s\S]{0,200}npm pack|npm pack[\s\S]{0,200}npm run build|packages\/sdk[\s\S]{0,80}npm run build/.test(
          source,
        ),
        `${file} does not document building the SDK from source`,
      ).toBe(true);
    }
  });
});

describe("quickstart is a real, wired page", () => {
  it("exists on disk and is advertised as a public route", () => {
    expect(existsSync(join(root, "app/docs/quickstart/page.tsx"))).toBe(true);
    expect(PUBLIC_ROUTES.map((r) => r.path)).toContain("/docs/quickstart");
  });

  it("walks the documented lifecycle without claiming the SDK is on npm", () => {
    const source = read("app/docs/quickstart/page.tsx");
    for (const call of [
      "createIntent",
      "validateIntent",
      "prepareTransaction",
      "authorizeIntent",
      "submitTransaction",
      "verifySettlement",
    ]) {
      expect(source, `quickstart omits ${call}`).toContain(call);
    }
    // It must be honest about the two capability gaps.
    expect(source).toMatch(/not yet published to npm/);
    expect(source).toMatch(/signup is closed|admin token/);
  });
});

describe("key issuance is described honestly", () => {
  it("says production signup is operator-gated in the developer and merchant guides", () => {
    for (const file of ["docs/developers.md", "docs/merchants.md"]) {
      const source = read(file);
      expect(
        /signup is closed|admin token/i.test(source),
        `${file} does not disclose that production key issuance is operator-gated`,
      ).toBe(true);
    }
  });

  it("does not present production signup as self-serve anywhere it is described", () => {
    const source = read("app/docs/quickstart/page.tsx");
    expect(source).toMatch(/signup is closed|admin token/);
    expect(source).not.toMatch(/sign up for free|create an account in one click/i);
  });
});

describe("headless example is honest and runnable", () => {
  const script = read("examples/status-and-verify/check.mjs");

  it("imports only the published SDK server entry point", () => {
    const imports = [...script.matchAll(/^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("node:") || specifier.includes("packages/sdk/dist"),
        `unexpected import in the example: ${specifier}`,
      ).toBe(true);
    }
    expect(script).not.toMatch(/from\s+["']@\//);
    expect(script).not.toMatch(/from\s+["'][^"']*\blib\//);
  });

  it("never treats anything but a verified verdict as paid", () => {
    expect(script).toMatch(/verdict === "verified"/);
    expect(script).toMatch(/Do not treat this as paid/);
    expect(script).toMatch(/process\.exitCode/);
  });
});
