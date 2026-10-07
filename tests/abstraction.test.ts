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
});
