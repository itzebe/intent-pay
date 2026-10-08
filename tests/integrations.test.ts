import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gasCapabilities, resolvePolicyStatus } from "@/lib/server/gasCapabilities";
import { resolveAbstraction, type AbstractionCapabilities } from "@/lib/domain/abstraction";
import { resolveGasMode } from "@/lib/execution/alchemy";
import { zerionEnabled, fetchZerionResult, fetchZerionPortfolio } from "@/lib/server/zerion";
import { getToken } from "@/lib/config/tokens";
import { GET as capabilitiesGET } from "@/app/api/capabilities/route";

const USDC = getToken("USDC")!;
const USDT = getToken("USDT")!;
const MON = getToken("MON")!;

const KEYS = [
  "ALCHEMY_API_KEY",
  "ALCHEMY_GAS_POLICY_ID",
  "ALCHEMY_GAS_POLICY_START_UNIX",
  "ALCHEMY_GAS_POLICY_END_UNIX",
  "ALCHEMY_PAYMASTER_TOKENS",
  "ZERION_API_KEY",
  "ZERION_ENABLED",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * Provider-configuration honesty contract.
 *
 * A key existing is never enough. These tests pin that the capability layer
 * distinguishes: configured, reachable, policy-in-window, per-token support,
 * and unavailable — and never collapses them into one boolean.
 */
describe("Alchemy gas configuration detection", () => {
  it("reports nothing configured when the environment is empty", () => {
    const caps = gasCapabilities("mainnet");
    expect(caps.alchemy).toBe(false);
    expect(caps.policyConfigured).toBe(false);
    expect(caps.sponsorshipConfigured).toBe(false);
    expect(caps.erc20GasConfigured).toBe(false);
    expect(caps.rpc).toBe("public");
  });

  it("has a key + policy but no token list → sponsorship possible, ERC-20 per-token unknown", () => {
    process.env.ALCHEMY_API_KEY = "k";
    process.env.ALCHEMY_GAS_POLICY_ID = "11111111-1111-1111-1111-111111111111";
    const caps = gasCapabilities("mainnet");
    expect(caps.alchemy).toBe(true);
    expect(caps.policyStatus).toBe("active");
    expect(caps.sponsorshipConfigured).toBe(true);
    // No token list → we must not claim any token is gas-abstracted.
    expect(caps.erc20GasConfigured).toBe(false);
    expect(caps.supportedTokens).toEqual([]);
  });

  it("treats an expired policy window as not sponsored", () => {
    process.env.ALCHEMY_API_KEY = "k";
    process.env.ALCHEMY_GAS_POLICY_ID = "11111111-1111-1111-1111-111111111111";
    process.env.ALCHEMY_GAS_POLICY_END_UNIX = String(Math.floor(Date.now() / 1000) - 3600);
    const caps = gasCapabilities("mainnet");
    expect(caps.policyStatus).toBe("expired");
    expect(caps.sponsorshipConfigured).toBe(false);
  });

  it("resolves policy status from a declared window", () => {
    expect(resolvePolicyStatus(undefined).status).toBe("unknown");
    expect(resolvePolicyStatus("p", 1000).status).toBe("active");
  });

  it("reads the sponsored token allowlist from configuration", () => {
    process.env.ALCHEMY_API_KEY = "k";
    process.env.ALCHEMY_GAS_POLICY_ID = "11111111-1111-1111-1111-111111111111";
    process.env.ALCHEMY_PAYMASTER_TOKENS = `not-a-token, ${USDC.address}`;
    const caps = gasCapabilities("mainnet");
    expect(caps.supportedTokens).toEqual([USDC.address.toLowerCase()]);
    expect(caps.erc20GasConfigured).toBe(true);
  });
});

describe("wallet abstraction state per token", () => {
  const base = (over: Partial<AbstractionCapabilities> = {}): AbstractionCapabilities => ({
    chainId: 143,
    chainSupported: true,
    paymasterConfigured: true,
    policyUsable: true,
    walletSupportsPaymaster: true,
    walletSupportsErc20Gas: false,
    walletSupportsBatch: true,
    supportedTokens: [USDC.address],
    ...over,
  });

  it("ABSTRACTION_AVAILABLE for a sponsored token (no-MON path)", () => {
    const r = resolveAbstraction(USDC, base());
    expect(r.state).toBe("ABSTRACTION_AVAILABLE");
    expect(r.abstracted).toBe(true);
    expect(r.gasOptions.sponsored).toBe(true);
  });

  it("TOKEN unsupported → honest fallback, no sponsorship claimed", () => {
    const r = resolveAbstraction(USDT, base());
    expect(r.state).toBe("ABSTRACTION_UNSUPPORTED_TOKEN");
    expect(r.abstracted).toBe(false);
    expect(r.message).toContain("USDT");
  });

  it("PAYMASTER_UNAVAILABLE when no policy is configured", () => {
    const r = resolveAbstraction(USDC, base({ paymasterConfigured: false, policyUsable: false }));
    expect(r.state).toBe("PAYMASTER_UNAVAILABLE");
  });

  it("POLICY_UNAVAILABLE when the policy is configured but expired", () => {
    const r = resolveAbstraction(USDC, base({ policyUsable: false, policyReason: "window ended" }));
    expect(r.state).toBe("POLICY_UNAVAILABLE");
    expect(r.abstracted).toBe(false);
    expect(r.message).toContain("window ended");
  });

  it("NATIVE_GAS_REQUIRED when paying with MON itself", () => {
    const r = resolveAbstraction(MON, base({ supportedTokens: [USDC.address] }));
    expect(r.state).toBe("NATIVE_GAS_REQUIRED");
  });

  it("no-MON wallet with an ERC-20-gas wallet but no paymaster → erc20 mode", () => {
    expect(resolveGasMode(false, false, true)).toBe("erc20");
  });

  it("no-MON wallet with neither → native fallback", () => {
    expect(resolveGasMode(false, false, false)).toBe("native");
  });
});

describe("Zerion configuration + never-break-execution", () => {
  it("is disabled without a key and does not throw", async () => {
    expect(zerionEnabled()).toBe(false);
    const res = await fetchZerionResult("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(res.status).toBe("disabled");
    expect(res.assets).toEqual([]);
    const pf = await fetchZerionPortfolio("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(pf.status).toBe("disabled");
    expect(pf.totalUsd).toBe(0);
  });

  it("honours ZERION_ENABLED=0 even with a key", async () => {
    process.env.ZERION_API_KEY = "zk_x";
    process.env.ZERION_ENABLED = "0";
    expect(zerionEnabled()).toBe(false);
    const res = await fetchZerionResult("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4");
    expect(res.status).toBe("disabled");
  });

  it("parses a real portfolio response shape (total + per-chain distribution)", async () => {
    process.env.ZERION_API_KEY = "zk_x";
    const real = {
      data: {
        attributes: {
          total: { positions: 2.524128860448 },
          positions_distribution_by_chain: { monad: 2.524128860448 },
        },
      },
    };
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify(real), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const pf = await fetchZerionPortfolio("0x6f49a8f621353f12378d0046e7d7e4b9b249dc9e");
      expect(pf.status).toBe("ok");
      expect(pf.totalUsd).toBeCloseTo(2.524128860448, 6);
      expect(pf.byChain).toEqual([{ chainId: "monad", usd: 2.524128860448 }]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("maps a 429 throttle to an error status, never a fabricated zero", async () => {
    process.env.ZERION_API_KEY = "zk_x";
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ title: "Too many requests" }] }), {
        status: 429,
      })) as typeof fetch;
    try {
      const pf = await fetchZerionPortfolio("0x6f49a8f621353f12378d0046e7d7e4b9b249dc9e");
      expect(pf.status).toBe("error");
      expect(pf.reason).toContain("429");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("capability endpoint honesty", () => {
  it("reports unconfigured providers without claiming capabilities", async () => {
    const res = await capabilitiesGET();
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.gas.alchemy).toBe(false);
    expect(json.gas.bundlerReachable).toBe(false);
    expect(json.gas.paymasterConfigured).toBe(false);
    expect(json.walletAbstraction.available).toBe(false);
    expect(typeof json.walletAbstraction.reason).toBe("string");
    expect(json.wallet.zerionConfigured).toBe(false);
  });
});
