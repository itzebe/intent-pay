import { describe, expect, it, afterEach, vi } from "vitest";

/**
 * Security headers are shipped from `next.config.mjs` `headers()`. These tests
 * assert the deployed policy shape so a future edit cannot silently drop a
 * hardening header or widen the CSP.
 */
async function loadConfig(nodeEnv?: string) {
  vi.resetModules();
  const env = process.env as Record<string, string | undefined>;
  const prev = env.NODE_ENV;
  if (nodeEnv) env.NODE_ENV = nodeEnv;
  const mod = await import("../next.config.mjs");
  if (prev === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = prev;
  return mod.default as {
    headers: () => Promise<
      { source: string; headers: { key: string; value: string }[] }[]
    >;
  };
}

function headerMap(rules: { source: string; headers: { key: string; value: string }[] }[], source: string) {
  const rule = rules.find((r) => r.source === source);
  return new Map((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  delete process.env.NEXT_PUBLIC_MONAD_RPC_URL;
});

describe("security headers (production)", () => {
  it("emits the core hardening headers on every route", async () => {
    const config = await loadConfig("production");
    const rules = await config.headers();
    const all = headerMap(rules, "/:path*");
    expect(all.get("X-Content-Type-Options")).toBe("nosniff");
    expect(all.get("X-Frame-Options")).toBe("DENY");
    expect(all.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(all.get("Strict-Transport-Security")).toContain("max-age=");
    expect(all.get("Permissions-Policy")).toContain("camera=()");
    expect(all.get("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
  });

  it("ships a lock-down Content-Security-Policy with no third-party script origins", async () => {
    const config = await loadConfig("production");
    const csp = headerMap(await config.headers(), "/:path*").get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    // Production must not enable eval.
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("adds the configured Alchemy origin to connect-src when a browser key is set", async () => {
    process.env.NEXT_PUBLIC_ALCHEMY_API_KEY = "test-key";
    const config = await loadConfig("production");
    const csp = headerMap(await config.headers(), "/:path*").get("Content-Security-Policy")!;
    expect(csp).toContain("https://monad-mainnet.g.alchemy.com");
  });

  it("marks API responses no-store so per-user wallet data is never cached", async () => {
    const config = await loadConfig("production");
    const api = headerMap(await config.headers(), "/api/:path*");
    expect(api.get("Cache-Control")).toBe("no-store");
  });
});

describe("security headers (development)", () => {
  it("permits eval and websockets so the dev server and fast-refresh work", async () => {
    const config = await loadConfig("development");
    const csp = headerMap(await config.headers(), "/:path*").get("Content-Security-Policy")!;
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws:");
  });
});
