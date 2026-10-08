import { describe, expect, it } from "vitest";
import {
  pickShortfallSource,
  splitNeedsSource,
  splitPayment,
} from "@/lib/domain/partialBalance";

describe("partial-balance split", () => {
  it("holds enough -> a single direct transfer", () => {
    const s = splitPayment("100", "150", 18);
    expect(s.mode).toBe("direct");
    expect(s.held).toBe("100");
    expect(s.shortfall).toBe("0");
    expect(splitNeedsSource(s)).toBe(false);
  });

  it("holds exactly enough -> direct, not a split", () => {
    const s = splitPayment("100", "100", 6);
    expect(s.mode).toBe("direct");
    expect(s.held).toBe("100");
    expect(s.shortfall).toBe("0");
  });

  it("holds none -> the whole amount is swapped", () => {
    const s = splitPayment("100", "0", 18);
    expect(s.mode).toBe("swap");
    expect(s.held).toBe("0");
    expect(s.shortfall).toBe("100");
    expect(splitNeedsSource(s)).toBe(true);
  });

  it("holds part -> send it and swap the remainder (the Part 5 example)", () => {
    // Want 100 NEWCOIN, hold 40 NEWCOIN -> 40 direct + 60 swapped.
    const s = splitPayment("100", "40", 18);
    expect(s.mode).toBe("split");
    expect(s.held).toBe("40");
    expect(s.shortfall).toBe("60");
    expect(splitNeedsSource(s)).toBe(true);
  });

  it("respects token decimals (a 6-dp token)", () => {
    const s = splitPayment("100", "40.5", 6);
    expect(s.mode).toBe("split");
    expect(s.held).toBe("40.5");
    expect(s.shortfall).toBe("59.5");
  });

  it("does exact integer arithmetic for tiny fractional remainders", () => {
    const s = splitPayment("1", "0.000000000000000001", 18);
    expect(s.mode).toBe("split");
    expect(s.held).toBe("0.000000000000000001");
    expect(s.shortfall).toBe("0.999999999999999999");
  });

  it("treats a malformed balance as zero rather than inventing a number", () => {
    const s = splitPayment("100", "not-a-number", 18);
    expect(s.mode).toBe("swap");
    expect(s.shortfall).toBe("100");
  });

  it("a non-positive target is a no-op direct split", () => {
    const s = splitPayment("0", "40", 18);
    expect(s.mode).toBe("direct");
    expect(s.shortfall).toBe("0");
  });
});

describe("shortfall source selection", () => {
  const funded = [
    { symbol: "USDC", address: "0xUSDC", usd: 100 },
    { symbol: "MON", address: "0x0", usd: 5 },
    { symbol: "NEWCOIN", address: "0xNEW", usd: 40 },
  ];

  it("picks the most valuable asset that is not the target", () => {
    expect(pickShortfallSource(funded, "0xNEW")?.symbol).toBe("USDC");
  });

  it("never picks the target asset as its own source", () => {
    // If NEWCOIN is the most valuable, it must still not be chosen to buy
    // itself.
    const onlyTarget = [{ symbol: "NEWCOIN", address: "0xNEW", usd: 999 }];
    expect(pickShortfallSource(onlyTarget, "0xNEW")).toBeNull();
  });

  it("returns null when nothing else is funded (refuse, never guess)", () => {
    expect(pickShortfallSource([], "0xNEW")).toBeNull();
    expect(
      pickShortfallSource([{ symbol: "ZERO", address: "0xZ", usd: 0 }], "0xNEW"),
    ).toBeNull();
  });
});
