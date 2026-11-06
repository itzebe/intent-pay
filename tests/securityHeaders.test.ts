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
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
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

  it("keeps frame-src 'none' and no WalletConnect origins when WC is not configured", async () => {
    const config = await loadConfig("production");
    const csp = headerMap(await config.headers(), "/:path*").get("Content-Security-Policy")!;
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain("walletconnect.com");
    expect(csp).not.toContain("secure.walletconnect.org");
    // No third-party font/logo origins leak in either.
    expect(csp).not.toContain("fonts.reown.com");
    expect(csp).not.toContain("api.web3modal.org");
  });

  it("relaxes the CSP for the WalletConnect relay and QR modal only when configured", async () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
    const config = await loadConfig("production");
    const csp = headerMap(await config.headers(), "/:path*").get("Content-Security-Policy")!;
    expect(csp).toContain("wss://relay.walletconnect.com");
    expect(csp).toContain("https://verify.walletconnect.org");
    expect(csp).toContain("https://secure.walletconnect.org");
    expect(csp).not.toContain("frame-src 'none'");
    // The QR modal renders wallet logos from the Web3Modal API and its own font.
    // Without these the mobile modal opens but never fills in.
    expect(csp).toContain("https://api.web3modal.org");
    expect(csp).toContain("https://fonts.reown.com");
    expect(csp).toMatch(/img-src[^;]*https:\/\/api\.web3modal\.org/);
    expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.reown\.com/);
  });

  /**
   * Defect A. A page-world injected wallet (Trust Wallet's Android in-app
   * browser) answers `eth_chainId`/`eth_call` by proxying to its own node. That
   * fetch runs in our page's context, so `connect-src` governs it: without the
   * origin the browser refuses the request and the connection can never
   * complete ("Couldn't connect to the wallet"). The wallet's own Monad RPC must
   * therefore be reachable — and, crucially, reachable *without* WalletConnect
   * being configured, because direct injected connection must not depend on it.
   */
  it("allows an injected wallet's own RPC origin even with no WalletConnect configured", async () => {
    delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    const config = await loadConfig("production");
    const csp = headerMap(await config.headers(), "/:path*").get("Content-Security-Policy")!;
    const connectSrc = csp.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";
    // Trust Wallet's Node-as-a-Service Monad RPC — the reported failing endpoint.
    expect(connectSrc).toContain("https://monad.twnodes.com");
    // ...and this relaxation does not smuggle in WalletConnect or any script origin.
    expect(csp).not.toContain("walletconnect.com");
    expect(csp).not.toContain("secure.walletconnect.org");
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toContain("monad.twnodes.com");
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
