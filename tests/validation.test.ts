import { describe, expect, it } from "vitest";
import {
  validateAmount,
  validateRecipient,
  isSelfPayment,
} from "@/lib/domain/validation";
import { detectAmountMismatch } from "@/lib/hooks/usePayment";

describe("validateRecipient", () => {
  it("accepts a valid address", () => {
    expect(validateRecipient("0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4")).toBeNull();
  });

  it("rejects empty, malformed, and zero addresses", () => {
    expect(validateRecipient("")?.code).toBe("invalid_recipient");
    expect(validateRecipient("0x123")?.code).toBe("invalid_recipient");
    expect(validateRecipient("not-an-address")?.code).toBe("invalid_recipient");
    expect(
      validateRecipient("0x0000000000000000000000000000000000000000")?.code,
    ).toBe("invalid_recipient");
  });
});

describe("validateAmount", () => {
  it("accepts positive amounts", () => {
    expect(validateAmount("5", 6)).toBeNull();
    expect(validateAmount("0.01", 6)).toBeNull();
  });

  it("rejects zero, negative, and non-numeric", () => {
    expect(validateAmount("0", 6)?.code).toBe("invalid_amount");
    expect(validateAmount("-1", 6)?.code).toBe("invalid_amount");
    expect(validateAmount("abc", 6)?.code).toBe("invalid_amount");
    expect(validateAmount("", 6)?.code).toBe("invalid_amount");
  });

  it("rejects amounts below one base unit", () => {
    expect(validateAmount("0.0000001", 6)?.code).toBe("invalid_amount");
  });
});

describe("isSelfPayment", () => {
  it("detects paying yourself case-insensitively", () => {
    expect(
      isSelfPayment("0xABC0000000000000000000000000000000000001", "0xabc0000000000000000000000000000000000001"),
    ).toBe(true);
    expect(
      isSelfPayment("0xABC0000000000000000000000000000000000001", "0xabc0000000000000000000000000000000000002"),
    ).toBe(false);
  });
});

describe("detectAmountMismatch (exact payment protection)", () => {
  it("flags when delivery exceeds intent", () => {
    const r = detectAmountMismatch("5", "6");
    expect(r.active).toBe(true);
    expect(r.difference).toBeCloseTo(1);
  });

  it("does not flag small rounding differences", () => {
    expect(detectAmountMismatch("5", "5.01").active).toBe(false);
  });

  it("does not flag when there is no recorded intent", () => {
    expect(detectAmountMismatch(null, "6").active).toBe(false);
  });

  it("does not flag a shortfall (normal in I-spend mode)", () => {
    expect(detectAmountMismatch("5", "4").active).toBe(false);
  });
});
