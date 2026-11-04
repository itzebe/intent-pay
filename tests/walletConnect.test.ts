import { describe, expect, it, afterEach, vi } from "vitest";

/**
 * The WalletConnect connector must be honest about whether it is configured:
 * with no project id it reports "not configured" and never fabricates a
 * session; with one it is offered. The heavy SDK is only imported lazily, so
 * these assertions do not load it.
 */

async function load() {
  vi.resetModules();
  return import("@/lib/wallet/walletconnect");
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
});

describe("walletconnect configuration gate", () => {
  it("reports not configured when no project id is set", async () => {
    const wc = await load();
    expect(wc.walletConnectConfigured()).toBe(false);
    expect(wc.walletConnectProjectId()).toBe("");
  });

  it("reports configured when a project id is present", async () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "  abc123  ";
    const wc = await load();
    expect(wc.walletConnectConfigured()).toBe(true);
    expect(wc.walletConnectProjectId()).toBe("abc123");
  });

  it("treats a whitespace-only id as not configured", async () => {
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "   ";
    const wc = await load();
    expect(wc.walletConnectConfigured()).toBe(false);
  });

  it("never returns a provider when not configured (no fabricated session)", async () => {
    const wc = await load();
    expect(await wc.getWalletConnectProvider()).toBeNull();
  });

  it("resetting an unconfigured connector is a no-op, not an error", async () => {
    const wc = await load();
    await expect(wc.resetWalletConnect()).resolves.toBeUndefined();
  });
});
