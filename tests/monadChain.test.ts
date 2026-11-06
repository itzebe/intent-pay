import { describe, expect, it } from "vitest";
import { isMonadChain, monadAddChainParams } from "@/lib/wallet/monadChain";
import { PUBLIC_MONAD_RPC } from "@/lib/config/chains";

/**
 * The EIP-3085 payload Intent Pay hands to a wallet when it must add Monad, and
 * the chain-id comparison used to decide whether a switch is needed.
 *
 * Defect B: the reported failure was `Failed to connect to
 * http://monad.twnodes.com/ ...:443`. That host is Trust Wallet's *own* Monad
 * RPC (its Node-as-a-Service node) — it is not, and must never be, an endpoint
 * this app supplies to a wallet. These tests pin the endpoints we do supply so a
 * regression that introduces a foreign or malformed RPC URL fails loudly.
 */
describe("monadAddChainParams (EIP-3085)", () => {
  it("adds Monad Mainnet with chain id 0x8f and the public Monad RPC", () => {
    const params = monadAddChainParams("mainnet");
    expect(params.chainId).toBe("0x8f");
    expect(params.rpcUrls[0]).toBe(PUBLIC_MONAD_RPC);
    expect(params.nativeCurrency.symbol).toBe("MON");
    expect(params.blockExplorerUrls[0]).toMatch(/^https:\/\//);
  });

  it("never supplies the obsolete/malformed wallet-side endpoint", () => {
    const params = monadAddChainParams("mainnet");
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain("twnodes");
    expect(serialized).not.toContain("3.33.251.223");
    // Every RPC URL we hand a wallet must be HTTPS — no plaintext `http://`.
    for (const url of params.rpcUrls) expect(url).toMatch(/^https:\/\//);
  });
});

describe("isMonadChain", () => {
  it("treats the hex and decimal forms of chain id 143 consistently", () => {
    expect(isMonadChain("0x8f")).toBe(true);
    expect(isMonadChain(143)).toBe(true);
    expect(isMonadChain("143")).toBe(true);
  });

  it("is false for another chain and for malformed input", () => {
    expect(isMonadChain("0x1")).toBe(false);
    expect(isMonadChain(1)).toBe(false);
    expect(isMonadChain(undefined)).toBe(false);
    expect(isMonadChain("0x")).toBe(false);
    expect(isMonadChain("nope")).toBe(false);
  });
});
