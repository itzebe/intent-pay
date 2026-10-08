import { describe, expect, it } from "vitest";
import { normalizeTokenConfig, registerToken } from "@/lib/config/tokens";

/**
 * A token from an external source (a wallet indexer, a pasted address, a remote
 * list) may be missing required display fields. A missing `tint` used to throw
 * inside the badge and blank the whole app (the USDC→MON report). Normalization
 * must guarantee every required field is present and never throw.
 */
describe("token shape normalization (crash-proofing)", () => {
  it("fills a missing tint deterministically, never leaving it undefined", () => {
    const t = normalizeTokenConfig({ symbol: "WIF", name: "dogwifhat", address: "0xABCDEF0000000000000000000000000000001234", decimals: 6 });
    expect(typeof t.tint).toBe("string");
    expect(t.tint.length).toBeGreaterThan(0);
    // Deterministic for the same address.
    const again = normalizeTokenConfig({ symbol: "WIF", name: "dogwifhat", address: "0xABCDEF0000000000000000000000000000001234", decimals: 6 });
    expect(again.tint).toBe(t.tint);
  });

  it("fills a missing symbol and name without throwing", () => {
    const t = normalizeTokenConfig({ address: "0xABCDEF0000000000000000000000000000001234", decimals: 6 });
    expect(t.symbol).toBe("Unknown");
    expect(t.name).toBeTruthy();
  });

  it("defaults invalid decimals to a safe value", () => {
    const t = normalizeTokenConfig({ symbol: "X", address: "0xABCDEF0000000000000000000000000000001234", decimals: 99 });
    expect(t.decimals).toBe(18);
  });

  it("never throws on a completely empty payload", () => {
    expect(() => normalizeTokenConfig({})).not.toThrow();
    const t = normalizeTokenConfig({});
    expect(typeof t.symbol).toBe("string");
    expect(typeof t.tint).toBe("string");
  });

  it("registration normalizes, so nothing malformed enters the registry", () => {
    const stored = registerToken(
      // Deliberately malformed cast, as an untyped external payload would be.
      { symbol: "BAD", address: "0xABCDEF0000000000000000000000000000009999", decimals: 6 } as never,
    );
    expect(typeof stored.tint).toBe("string");
    expect(stored.tint.length).toBeGreaterThan(0);
  });
});
