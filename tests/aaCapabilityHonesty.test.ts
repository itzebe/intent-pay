import { describe, expect, it } from "vitest";
import { resolveWalletAbstraction } from "@/lib/aa/capability";

/**
 * Capability honesty (section 10).
 *
 * The server cannot observe a browser wallet signature, so the capability model
 * exposes only what it can actually check: provider support, a funded token and
 * the client-supplied wallet-compatibility signal. It must never claim the
 * EIP-7702 authorization is prepared. `available` means "the provider and a
 * funded token support ERC-20 gas", not "the operation is signed and ready".
 */

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;

const base = {
  chainId: 143,
  providerConfigured: true,
  providerReachable: true,
  providerId: "pimlico",
  walletCompatible: true,
  account: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as `0x${string}`,
};

const usdcView = {
  chainId: 143,
  address: USDC,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  held: true,
  balance: "5",
  sufficientBalance: true,
  quoteKnown: true,
  estimatedFee: "0.0019",
  estimatedFeeUsd: "0.0019",
  selected: true,
};

describe("resolveWalletAbstraction honesty", () => {
  it("reports ERC-20 gas support without claiming the authorization is prepared", () => {
    const cap = resolveWalletAbstraction({
      ...base,
      selection: {
        selected: { address: USDC, symbol: "USDC", decimals: 6, balance: 5_000_000n } as never,
        viable: [],
        code: "auto_best",
        reason: "Best available gas token: USDC.",
        nativeRequired: false,
      },
      supportedGasTokens: [usdcView],
    });
    expect(cap.available).toBe(true);
    expect(cap.mode).toBe("ERC20_PAYMASTER");
    expect(cap.walletCompatible).toBe(true);
    // The model must not expose a readiness claim it cannot verify server-side.
    expect(cap).not.toHaveProperty("authorizationPrepared");
  });

  it("mirrors the client's walletCompatible signal without asserting a capability it cannot check", () => {
    const cap = resolveWalletAbstraction({
      ...base,
      walletCompatible: false,
      selection: { selected: null, viable: [], code: "wallet_incompatible", reason: "", nativeRequired: true },
    });
    expect(cap.walletCompatible).toBe(false);
    expect(cap).not.toHaveProperty("authorizationPrepared");
    expect(cap.mode).toBe("NATIVE");
  });
});
