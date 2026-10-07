import { describe, expect, it, beforeEach } from "vitest";
import {
  allTokens,
  catalogVersion,
  configFromCurated,
  curatedCatalog,
  getToken,
  getTokenByAddress,
  poolAddressOf,
  resetCatalog,
  setActiveCatalog,
  type CuratedToken,
} from "@/lib/config/tokens";
import { searchTokens } from "@/lib/server/discovery";
import { WMON_ADDRESS } from "@/lib/providers/constants";

const NEW_TOKEN: CuratedToken = {
  address: "0xDeAd00000000000000000000000000000000BEEF",
  symbol: "NEWT",
  name: "Newly Listed Token",
  decimals: 9,
};

describe("runtime catalog (future-proof for new Monad tokens)", () => {
  beforeEach(() => {
    // Reset to the shipped fallback between tests.
    resetCatalog();
  });
  it("falls back to the shipped snapshot by default", () => {
    const list = curatedCatalog();
    expect(list.length).toBeGreaterThan(100);
    expect(list.some((t) => t.symbol === "USDC")).toBe(true);
  });

  it("surfaces a token that only exists in the runtime catalog", () => {
    setActiveCatalog([NEW_TOKEN], "with-newt");
    const found = curatedCatalog().find((t) => t.address.toLowerCase() === NEW_TOKEN.address.toLowerCase());
    expect(found?.symbol).toBe("NEWT");
  });

  it("bumps the catalog version when the catalog changes", () => {
    const before = catalogVersion();
    setActiveCatalog([NEW_TOKEN], "v2");
    expect(catalogVersion()).toBe("v2");
    expect(catalogVersion()).not.toBe(before);
  });

  it("resolves a runtime-catalog token by symbol and by address", () => {
    setActiveCatalog([NEW_TOKEN], "with-newt");
    const bySymbol = getToken("NEWT");
    expect(bySymbol?.symbol).toBe("NEWT");
    expect(bySymbol?.decimals).toBe(9);
    const byAddress = getTokenByAddress(NEW_TOKEN.address);
    expect(byAddress?.symbol).toBe("NEWT");
  });

  it("searchTokens finds a runtime-catalog token by symbol and name", () => {
    setActiveCatalog([NEW_TOKEN], "with-newt");
    expect(searchTokens("newt").map((t) => t.symbol)).toContain("NEWT");
    expect(searchTokens("Newly Listed").map((t) => t.symbol)).toContain("NEWT");
  });

  it("searchTokens also finds tokens imported at runtime (registry)", () => {
    setActiveCatalog([], "empty");
    configFromCurated({
      address: "0x00000000000000000000000000000000000000Ab",
      symbol: "PASTED",
      name: "Pasted Token",
      decimals: 18,
    });
    expect(searchTokens("pasted").map((t) => t.symbol)).toContain("PASTED");
  });

  it("derives a stable pool address for native and ERC-20 tokens", () => {
    const mon = getToken("MON")!;
    const usdc = getToken("USDC")!;
    expect(poolAddressOf(mon)).toBe(WMON_ADDRESS.toLowerCase());
    expect(poolAddressOf(usdc)).toBe(usdc.address.toLowerCase());
  });

  it("configFromCurated registers a discovered token with its metadata", () => {
    const cfg = configFromCurated(NEW_TOKEN);
    expect(cfg.decimals).toBe(9);
    expect(cfg.source).toBe("list");
    expect(allTokens().some((t) => t.symbol === "NEWT")).toBe(true);
  });
});
