import { describe, expect, it } from "vitest";
import {
  deriveTokenState,
  tokenStateFlags,
  tokenStateLabel,
  type TokenCapabilities,
} from "@/lib/domain/tokenState";

function caps(partial: Partial<TokenCapabilities>): TokenCapabilities {
  return {
    exists: true,
    identified: true,
    priced: true,
    routable: true,
    routeProbed: true,
    ...partial,
  };
}

describe("token state model", () => {
  it("UNKNOWN when the token cannot be identified", () => {
    expect(deriveTokenState(caps({ exists: false }))).toBe("UNKNOWN");
    expect(deriveTokenState(caps({ identified: false }))).toBe("UNKNOWN");
    expect(tokenStateFlags(caps({ exists: false }))).toEqual(["UNKNOWN"]);
  });

  it("PRICE_UNAVAILABLE when it exists but has no trustworthy price", () => {
    expect(deriveTokenState(caps({ priced: false }))).toBe("PRICE_UNAVAILABLE");
  });

  it("PRICE_AVAILABLE when priced but not yet route-probed", () => {
    expect(deriveTokenState(caps({ routeProbed: false }))).toBe("PRICE_AVAILABLE");
  });

  it("ROUTE_UNAVAILABLE when priced but no usable route", () => {
    expect(deriveTokenState(caps({ routable: false }))).toBe("ROUTE_UNAVAILABLE");
  });

  it("PAYABLE only when it exists, is priced, and has a route", () => {
    expect(deriveTokenState(caps({}))).toBe("PAYABLE");
  });

  it("a token that exists with metadata but no price and no route is DISCOVERED, not payable", () => {
    // The exact Part 7 example.
    const c = caps({ priced: false, routable: false });
    const state = deriveTokenState(c);
    expect(state).not.toBe("PAYABLE");
    const flags = tokenStateFlags(c);
    expect(flags).toContain("DISCOVERED");
    expect(flags).toContain("PRICE_UNAVAILABLE");
    expect(flags).toContain("ROUTE_UNAVAILABLE");
    expect(flags).not.toContain("PAYABLE");
  });

  it("a token with price but no route is never PAYABLE", () => {
    const flags = tokenStateFlags(caps({ routable: false }));
    expect(flags).toContain("PRICE_AVAILABLE");
    expect(flags).toContain("ROUTE_UNAVAILABLE");
    expect(flags).not.toContain("PAYABLE");
  });

  it("a route but no price is never PAYABLE", () => {
    const flags = tokenStateFlags(caps({ priced: false }));
    expect(flags).toContain("ROUTE_AVAILABLE");
    expect(flags).not.toContain("PAYABLE");
  });

  it("exposes a human label for each state", () => {
    expect(tokenStateLabel("PAYABLE")).toBe("Payable");
    expect(tokenStateLabel("ROUTE_UNAVAILABLE")).toBe("No route");
    expect(tokenStateLabel("PRICE_UNAVAILABLE")).toBe("Price unavailable");
    expect(tokenStateLabel("UNKNOWN")).toBe("Unknown");
  });
});
