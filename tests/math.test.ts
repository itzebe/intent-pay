import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "@/lib/domain/math";

describe("parseUnits", () => {
  it("parses whole numbers", () => {
    expect(parseUnits("5", 6)).toBe(5_000_000n);
    expect(parseUnits("5", 9)).toBe(5_000_000_000n);
    expect(parseUnits("1", 18)).toBe(10n ** 18n);
  });

  it("parses decimals and pads correctly", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("0.000001", 6)).toBe(1n);
    expect(parseUnits("0.1", 9)).toBe(100_000_000n);
  });

  it("handles edge inputs", () => {
    expect(parseUnits("0", 6)).toBe(0n);
    expect(parseUnits(".5", 6)).toBe(500_000n);
  });

  it("rejects malformed input", () => {
    expect(() => parseUnits("abc", 6)).toThrow();
    expect(() => parseUnits("", 6)).toThrow();
    expect(() => parseUnits("1.2.3", 6)).toThrow();
  });
});

describe("formatUnits", () => {
  it("round-trips", () => {
    expect(formatUnits(5_000_000n, 6)).toBe("5");
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(10n ** 18n, 18)).toBe("1");
  });

  it("trims trailing zeros", () => {
    expect(formatUnits(1_230_000n, 6)).toBe("1.23");
  });
});
