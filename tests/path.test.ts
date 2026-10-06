import { describe, expect, it } from "vitest";
import { encodePath } from "@/lib/execution/path";

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;
const C = "0x3333333333333333333333333333333333333333" as const;

describe("encodePath", () => {
  it("encodes a single hop as token + fee + token", () => {
    const p = encodePath([A, B], [500]);
    expect(p.length).toBe(2 + 20 * 2 * 2 + 3 * 2);
    expect(p.slice(2, 42)).toBe(A.slice(2));
    expect(p.slice(42, 48)).toBe("0001f4"); // 500
    expect(p.slice(48)).toBe(B.slice(2));
  });

  it("reverses tokens and fees for exact output", () => {
    const forward = encodePath([A, B], [500]);
    const reversed = encodePath([A, B], [500], true);
    expect(reversed).not.toBe(forward);
    expect(reversed.startsWith("0x" + B.slice(2))).toBe(true);
  });

  it("encodes multi-hop paths", () => {
    const p = encodePath([A, B, C], [500, 3000]);
    expect(p.length).toBe(2 + 20 * 3 * 2 + 3 * 2 * 2);
    expect(p.startsWith("0x" + A.slice(2))).toBe(true);
    expect(p.slice(42, 48)).toBe("0001f4"); // 500
    expect(p.slice(48, 88)).toBe(B.slice(2));
    expect(p.slice(88, 94)).toBe("000bb8"); // 3000
    expect(p.slice(94)).toBe(C.slice(2));
  });
});
