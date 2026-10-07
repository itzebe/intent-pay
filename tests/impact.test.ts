import { describe, expect, it } from "vitest";
import { computePriceImpact, spotProbeInput } from "@/lib/domain/impact";

describe("computePriceImpact", () => {
  it("reports ~0 impact when execution matches the near-spot rate", () => {
    // 1_000_000 in -> 1_000_000 out; probe 100 in -> 100 out (same rate).
    expect(computePriceImpact(1_000_000n, 1_000_000n, 100n, 100n)).toBe(0);
  });

  it("reports a positive impact when the trade rate is worse than spot", () => {
    // Probe rate 1.0, trade rate 0.9 -> 10% impact.
    const impact = computePriceImpact(1_000_000n, 900_000n, 100n, 100n);
    expect(impact).toBeCloseTo(0.1, 6);
  });

  it("never returns a negative impact (favourable fill is 0)", () => {
    // Trade rate better than spot must clamp to 0, not a negative value.
    expect(computePriceImpact(1_000_000n, 1_100_000n, 100n, 100n)).toBe(0);
  });

  it("returns null when the probe could not be quoted", () => {
    expect(computePriceImpact(1_000_000n, 900_000n, 100n, null)).toBeNull();
  });

  it("returns null for degenerate inputs", () => {
    expect(computePriceImpact(0n, 0n, 100n, 100n)).toBeNull();
    expect(computePriceImpact(1_000_000n, 900_000n, 1_000_000n, 900_000n)).toBeNull();
  });
});

describe("spotProbeInput", () => {
  it("is 0.01% of the trade", () => {
    expect(spotProbeInput(1_000_000n)).toBe(100n);
  });

  it("never drops below one base unit", () => {
    expect(spotProbeInput(5n)).toBe(1n);
    expect(spotProbeInput(0n)).toBe(1n);
  });
});
