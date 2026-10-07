import { describe, expect, it } from "vitest";
import { parseRemoteTokenList } from "@/lib/server/tokenList";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("parseRemoteTokenList (runtime discovery source)", () => {
  it("keeps valid entries for the requested chain", () => {
    const out = parseRemoteTokenList(
      {
        tokens: [
          { chainId: 143, address: A, symbol: "AAA", name: "Token A", decimals: 18 },
          { chainId: 143, address: B, symbol: "BBB", name: "Token B", decimals: 6, logoURI: "x" },
        ],
      },
      143,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ symbol: "AAA", decimals: 18 });
    expect(out[1].logoURI).toBe("x");
  });

  it("drops entries for the wrong chain", () => {
    const out = parseRemoteTokenList(
      {
        tokens: [
          { chainId: 1, address: A, symbol: "AAA", name: "Token A", decimals: 18 },
          { chainId: 143, address: B, symbol: "BBB", name: "Token B", decimals: 6 },
        ],
      },
      143,
    );
    expect(out.map((t) => t.symbol)).toEqual(["BBB"]);
  });

  it("drops malformed entries instead of guessing", () => {
    const out = parseRemoteTokenList(
      {
        tokens: [
          { chainId: 143, address: "0x123", symbol: "SHORT", name: "Bad", decimals: 18 },
          { chainId: 143, address: A, symbol: "", name: "No symbol", decimals: 18 },
          { chainId: 143, address: B, symbol: "BBB", name: "No decimals", decimals: -1 },
          { chainId: 143, address: A, symbol: "AAA", name: "Good", decimals: 18 },
        ],
      },
      143,
    );
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("AAA");
  });

  it("de-duplicates by address (case-insensitive)", () => {
    const out = parseRemoteTokenList(
      {
        tokens: [
          { chainId: 143, address: A, symbol: "AAA", name: "Token A", decimals: 18 },
          { chainId: 143, address: A.toUpperCase(), symbol: "AAA2", name: "Dup", decimals: 18 },
        ],
      },
      143,
    );
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("AAA");
  });

  it("returns an empty array for non-list payloads", () => {
    expect(parseRemoteTokenList(null, 143)).toEqual([]);
    expect(parseRemoteTokenList({}, 143)).toEqual([]);
    expect(parseRemoteTokenList({ tokens: "nope" }, 143)).toEqual([]);
  });
});
