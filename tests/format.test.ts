import { describe, expect, it } from "vitest";
import { formatImpact, formatUsd } from "@/lib/format";

describe("formatUsd", () => {
  it("formats money to cents", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("never renders a tiny negative as -$0.00", () => {
    expect(formatUsd(-0.001)).toBe("$0.00");
    expect(formatUsd(-0)).toBe("$0.00");
  });

  it("keeps real negatives signed", () => {
    expect(formatUsd(-2.5)).toBe("$-2.50");
  });
});

describe("formatImpact", () => {
  it("formats a fraction as a percentage", () => {
    expect(formatImpact(0.0012)).toBe("0.12%");
    expect(formatImpact(0.1)).toBe("10.00%");
    expect(formatImpact(0)).toBe("0.00%");
  });

  it("returns null for unusable input so callers can say unavailable", () => {
    expect(formatImpact(null)).toBeNull();
    expect(formatImpact(undefined)).toBeNull();
    expect(formatImpact(-0.1)).toBeNull();
    expect(formatImpact(NaN)).toBeNull();
  });
});
