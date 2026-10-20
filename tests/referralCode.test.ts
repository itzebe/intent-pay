import { describe, expect, it } from "vitest";
import { generateCode, generateUniqueCode, isValidCode, normalizeCode } from "@/lib/domain/referralCode";

/**
 * Regression for the referral-code generator.
 *
 * The alphabet is 31 symbols but the generator masked each random byte to 5 bits
 * (0–31). Index 31 is out of range, so roughly 1 in 32 characters was
 * `undefined`, producing an intermittently invalid code (and an unusable share
 * link). These tests pin a valid code on every draw.
 */
describe("referral code generator", () => {
  it("always produces a valid, normalisable code (no undefined characters)", () => {
    for (let i = 0; i < 5000; i++) {
      const code = generateCode();
      expect(code).not.toContain("undefined");
      expect(isValidCode(code)).toBe(true);
      expect(normalizeCode(code)).toBe(code);
    }
  });

  it("generates codes that are unique enough across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateCode());
    expect(seen.size).toBe(2000);
  });

  it("retries past a taken code", () => {
    let calls = 0;
    const code = generateUniqueCode(() => {
      calls += 1;
      return calls <= 3; // first three are "taken"
    });
    expect(isValidCode(code)).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("rejects malformed input", () => {
    expect(normalizeCode("")).toBeNull();
    expect(normalizeCode("INTENT-SHORT")).toBeNull();
    expect(normalizeCode("INTENT-000000")).toBeNull(); // 0/O/1/I/L excluded
    expect(normalizeCode("INTENT-ABCDEF")).toBe("INTENT-ABCDEF");
  });
});
