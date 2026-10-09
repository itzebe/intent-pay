import { describe, expect, it } from "vitest";
import { resolveAbstraction, isTokenSponsored, type AbstractionCapabilities } from "@/lib/domain/abstraction";
import { getToken } from "@/lib/config/tokens";

const USDC = getToken("USDC")!;
const MON = getToken("MON")!;

const base: AbstractionCapabilities = {
  chainId: 143,
  chainSupported: true,
  paymasterConfigured: true,
  walletSupportsPaymaster: true,
  walletSupportsErc20Gas: false,
  walletSupportsBatch: true,
  supportedTokens: [USDC.address],
};

/**
 * Wallet abstraction is a per-payment, nameable state — not a boolean. These
 * tests pin the honesty contract: sponsorship is only claimed when it is truly
 * available for the selected asset, and every other case says exactly why.
 */
describe("wallet abstraction state", () => {
  it("is available when the paymaster sponsors the selected token", () => {
    const r = resolveAbstraction(USDC, base);
    expect(r.state).toBe("ABSTRACTION_AVAILABLE");
    expect(r.abstracted).toBe(true);
    expect(r.gasOptions.sponsored).toBe(true);
  });

  it("is unsupported-token when the paymaster does not cover the asset", () => {
    const other = { ...USDC, address: "0x9999999999999999999999999999999999999999" as const, symbol: "XYZ" };
    const r = resolveAbstraction(other, base);
    expect(r.state).toBe("ABSTRACTION_UNSUPPORTED_TOKEN");
    expect(r.abstracted).toBe(false);
    expect(r.message).toContain("XYZ");
  });

  it("never claims sponsorship when no paymaster is configured", () => {
    const r = resolveAbstraction(USDC, { ...base, paymasterConfigured: false });
    expect(r.state).toBe("PAYMASTER_UNAVAILABLE");
    expect(r.abstracted).toBe(false);
  });

  it("is unsupported-wallet when the wallet advertises nothing", () => {
    const r = resolveAbstraction(USDC, {
      ...base,
      walletSupportsPaymaster: false,
      walletSupportsErc20Gas: false,
    });
    expect(r.state).toBe("ABSTRACTION_UNSUPPORTED_WALLET");
  });

  it("reports native gas required when paying with MON", () => {
    const r = resolveAbstraction(MON, { ...base, supportedTokens: [] });
    expect(r.state).toBe("NATIVE_GAS_REQUIRED");
    expect(r.abstracted).toBe(false);
    expect(r.gasOptions.native).toBe(true);
  });

  it("offers ERC-20 gas payment for any non-native token when the wallet supports it", () => {
    const r = resolveAbstraction(USDC, { ...base, walletSupportsErc20Gas: true, supportedTokens: [] });
    expect(r.state).toBe("ABSTRACTION_AVAILABLE");
    expect(r.gasOptions.erc20GasPayment).toBe(true);
  });

  it("treats an unknown supported-token set as not sponsored", () => {
    expect(isTokenSponsored(USDC, [])).toBe(false);
    expect(isTokenSponsored(USDC, [USDC.address])).toBe(true);
    expect(isTokenSponsored(MON, [MON.address])).toBe(false);
  });

  /**
   * A configured, reachable ERC-20 gas provider (Pimlico) is a paymaster in its
   * own right. When it is configured the app must NEVER claim "no paymaster is
   * configured" — that was the false production message.
   */
  it("does not claim no paymaster when an ERC-20 gas provider is configured", () => {
    const r = resolveAbstraction(USDC, {
      ...base,
      paymasterConfigured: false,
      erc20ProviderConfigured: true,
      erc20ProviderAvailable: true,
      walletSupportsErc20Gas: true,
    });
    expect(r.state).not.toBe("PAYMASTER_UNAVAILABLE");
    expect(r.message).not.toMatch(/no paymaster is configured/i);
    expect(r.gasOptions.erc20GasPayment).toBe(true);
  });

  it("reports a specific ERC-20-provider reason when it is configured but unavailable", () => {
    const r = resolveAbstraction(USDC, {
      ...base,
      paymasterConfigured: false,
      erc20ProviderConfigured: true,
      erc20ProviderAvailable: false,
      erc20ProviderReason: "Request timed out",
      walletSupportsErc20Gas: true,
    });
    expect(r.state).toBe("PAYMASTER_UNAVAILABLE");
    expect(r.message).toContain("Request timed out");
    expect(r.message).not.toMatch(/no paymaster is configured/i);
  });

  it("says the wallet can't pay in an ERC-20 when the provider is up but the wallet is not compatible", () => {
    const r = resolveAbstraction(USDC, {
      ...base,
      paymasterConfigured: false,
      erc20ProviderConfigured: true,
      erc20ProviderAvailable: true,
      walletSupportsErc20Gas: false,
      walletSupportsPaymaster: false,
    });
    expect(r.state).toBe("ABSTRACTION_UNSUPPORTED_WALLET");
    expect(r.message).not.toMatch(/no paymaster is configured/i);
  });
});
