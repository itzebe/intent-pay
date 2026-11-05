import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The merchant example proves Intent Pay is usable as infrastructure by a
 * *third party*. That claim only holds if the example imports the published
 * contracts and nothing else — the moment it reaches into the app's own modules
 * (`@/…`, `lib/…`, `components/…`, `app/…`) it stops being an independent
 * integration and becomes an in-repo client, and the pilot's evidence is void.
 *
 * These assertions are the guard for that: they read the real files and fail if
 * the example ever couples to application internals.
 */

const root = process.cwd();
const server = readFileSync(join(root, "examples", "merchant", "server.mjs"), "utf8");
const page = readFileSync(join(root, "examples", "merchant", "public", "index.html"), "utf8");
const readme = readFileSync(join(root, "examples", "merchant", "README.md"), "utf8");

describe("merchant example is an independent integration", () => {
  it("imports only the published SDK and node built-ins on the server", () => {
    const imports = [...server.matchAll(/^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      const isNodeBuiltin = specifier.startsWith("node:");
      const isSdk = specifier.includes("packages/sdk/dist");
      expect(isNodeBuiltin || isSdk, `unexpected import in the example: ${specifier}`).toBe(true);
    }
  });

  it("never reaches into application internals", () => {
    for (const [name, source] of [["server.mjs", server], ["index.html", page]] as const) {
      expect(source, `${name} must not use the app path alias`).not.toMatch(/from\s+["']@\//);
      expect(source, `${name} must not import lib/`).not.toMatch(/from\s+["'][^"']*\blib\//);
      expect(source, `${name} must not import components/`).not.toMatch(/from\s+["'][^"']*\bcomponents\//);
      expect(source, `${name} must not import app/`).not.toMatch(/from\s+["'][^"']*\bapp\//);
    }
  });

  it("keeps the API key on the server, never in the browser page", () => {
    // The browser page must not carry a credential or a bearer header.
    expect(page).not.toMatch(/Authorization/);
    expect(page).not.toMatch(/ipk_/);
    expect(page).not.toMatch(/apiKey/);
    // The server is where the key lives.
    expect(server).toMatch(/INTENTPAY_API_KEY/);
  });

  it("drives the documented lifecycle end to end", () => {
    // Each of the eight steps the README promises has a real call behind it.
    expect(server).toMatch(/getAccount\(\)/);
    expect(server).toMatch(/getAttribution\(\)/);
    expect(server).toMatch(/setAttribution\(/);
    expect(server).toMatch(/createIntent\(/);
    expect(server).toMatch(/validateIntent\(/);
    expect(server).toMatch(/createCheckout\(/);
    expect(server).toMatch(/verifyWebhookSignature\(/);
    expect(server).toMatch(/getCheckoutEvidence\(/);
    // The customer view is read from the public, token-authenticated route.
    expect(server).toMatch(/\/api\/checkout\//);
  });

  it("documents the run steps and the honest limits", () => {
    expect(readme).toMatch(/INTENTPAY_API_KEY/);
    expect(readme).toMatch(/npm --prefix packages\/sdk run build/);
    expect(readme).toMatch(/merchant credential can build and\s+verify a payment but can never authorize/);
  });
});
