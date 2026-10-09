import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Address } from "viem";

/**
 * Dynamic token discovery, with the RPC layer mocked so we can drive exact
 * chain responses. These prove the *real* discovery code path (metadata read,
 * existence check, external-metadata confirmation) rather than a stub.
 */
const getBytecode = vi.fn();
const call = vi.fn();

vi.mock("@/lib/server/rpc", () => ({
  getPublicClient: () => ({ getBytecode, call, multicall: vi.fn(async () => []) }),
}));

const { resolveByAddress, resolveToken, resolveSymbol } = await import("@/lib/server/discovery");
const { getTokenByAddress, registerToken, tintForAddress } = await import("@/lib/config/tokens");

/** ABI-encode a string return value (offset + length + data). */
function encodeString(s: string): `0x${string}` {
  const hex = Buffer.from(s, "utf8").toString("hex");
  const len = (hex.length / 2).toString(16).padStart(64, "0");
  const offset = (32).toString(16).padStart(64, "0");
  const data = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return `0x${offset}${len}${data}`;
}
function encodeUint(n: number): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

const NEW = "0x1111111111111111111111111111111111111111" as Address;

beforeEach(() => {
  getBytecode.mockReset();
  call.mockReset();
});

describe("resolveByAddress (the 'new token tomorrow' path)", () => {
  it("reports a non-contract address honestly (no invented symbol)", async () => {
    getBytecode.mockResolvedValue("0x");
    const res = await resolveByAddress("0x2222222222222222222222222222222222222222", "mainnet");
    expect(res.exists).toBe(false);
    expect(res.problem).toMatch(/no token contract/i);
    expect(res.token.symbol).toBe("Unknown");
  });

  it("reads symbol/name/decimals from the contract and registers it", async () => {
    getBytecode.mockResolvedValue("0x60806040");
    call.mockImplementation(async ({ data }: { data: string }) => {
      if (data === "0x95d89b41") return { data: encodeString("WIDGET") };
      if (data === "0x06fdde03") return { data: encodeString("Widget Coin") };
      if (data === "0x313ce567") return { data: encodeUint(8) };
      return { data: "0x" };
    });

    const res = await resolveByAddress(NEW, "mainnet");
    expect(res.exists).toBe(true);
    expect(res.source).toBe("onchain");
    expect(res.token.symbol).toBe("WIDGET");
    expect(res.token.name).toBe("Widget Coin");
    expect(res.token.decimals).toBe(8);
    // Registered so it is searchable/quoted app-wide afterwards.
    expect(getTokenByAddress(NEW)?.symbol).toBe("WIDGET");
  });

  it("rejects a contract that exposes no standard decimals", async () => {
    getBytecode.mockResolvedValue("0x60806040");
    call.mockResolvedValue({ data: "0x" });
    const res = await resolveByAddress("0x3333333333333333333333333333333333333333", "mainnet");
    expect(res.exists).toBe(true);
    expect(res.problem).toMatch(/decimals/i);
  });

  it("confirms externally-reported (wallet-source) decimals on chain", async () => {
    // Simulate a token an indexer reported with WRONG decimals (6), while the
    // contract itself says 18. The chain must win.
    const external = "0x4444444444444444444444444444444444444444" as Address;
    registerToken({
      symbol: "EXT",
      name: "External Token",
      address: external,
      decimals: 6,
      fallbackUsd: 0,
      tint: tintForAddress(external),
      source: "wallet",
    });
    getBytecode.mockResolvedValue("0x60806040");
    call.mockImplementation(async ({ data }: { data: string }) => {
      if (data === "0x95d89b41") return { data: encodeString("EXT") };
      if (data === "0x06fdde03") return { data: encodeString("External Token") };
      if (data === "0x313ce567") return { data: encodeUint(18) };
      return { data: "0x" };
    });

    const res = await resolveByAddress(external, "mainnet");
    expect(res.exists).toBe(true);
    expect(res.token.decimals).toBe(18); // authoritative, not the reported 6
    expect(getTokenByAddress(external)?.decimals).toBe(18);
  });

  it("keeps the reported decimals when the chain read fails (never invents one)", async () => {
    const external = "0x5555555555555555555555555555555555555555" as Address;
    registerToken({
      symbol: "EXT2",
      name: "External Two",
      address: external,
      decimals: 9,
      fallbackUsd: 0,
      tint: tintForAddress(external),
      source: "wallet",
    });
    getBytecode.mockRejectedValue(new Error("rpc down"));
    const res = await resolveByAddress(external, "mainnet");
    expect(res.token.decimals).toBe(9);
  });
});

describe("resolveToken by symbol", () => {
  it("resolves a shipped seed symbol", async () => {
    const res = await resolveToken("USDC", "mainnet");
    expect(res?.token.symbol).toBe("USDC");
    expect(res?.exists).toBe(true);
  });

  it("resolves a seed symbol case-insensitively", async () => {
    const res = await resolveToken("usdc", "mainnet");
    expect(res?.token.symbol).toBe("USDC");
    expect(res?.token.address).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
  });

  it("resolves a token by its display NAME, returning the canonical address", async () => {
    // The user must never have to paste a contract address: "USD Coin" must
    // resolve to the same token (and address) as the "USDC" ticker.
    const byName = await resolveToken("USD Coin", "mainnet");
    expect(byName?.token.symbol).toBe("USDC");
    expect(byName?.token.address).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    expect(byName?.exists).toBe(true);
  });

  it("matches the display name case-insensitively", async () => {
    const res = await resolveToken("usd coin", "mainnet");
    expect(res?.token.symbol).toBe("USDC");
  });

  it("prefers the ticker over a name so a shared name cannot shadow it", async () => {
    // A name that equals another token's ticker still resolves by ticker first.
    const res = await resolveToken("USDT", "mainnet");
    expect(res?.token.symbol).toBe("USDT");
  });

  it("returns null for an unknown symbol that is not an address", async () => {
    const res = await resolveToken("NOT-A-TOKEN-XYZ", "mainnet");
    expect(res).toBeNull();
  });
});

describe("resolveSymbol — ambiguity is never guessed", () => {
  it("resolves a unique symbol in the catalog", () => {
    const r = resolveSymbol("USDC");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.token.symbol).toBe("USDC");
      expect(r.token.address).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    }
  });

  it("resolves a runtime-registered token that is not in the catalog", () => {
    const addr = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
    registerToken({
      symbol: "NEWCOIN",
      name: "New Coin",
      address: addr,
      decimals: 18,
      fallbackUsd: 0,
      tint: tintForAddress(addr),
      source: "onchain",
    });
    const r = resolveSymbol("NEWCOIN");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.token.address).toBe(addr);
      expect(r.token.decimals).toBe(18);
    }
  });

  it("returns AMBIGUOUS (never a guess) when two contracts share a ticker", () => {
    const a = "0x1111111111111111111111111111111111111111" as Address;
    const b = "0x2222222222222222222222222222222222222222" as Address;
    registerToken({
      symbol: "DUP",
      name: "Dup One",
      address: a,
      decimals: 18,
      fallbackUsd: 0,
      tint: tintForAddress(a),
      source: "onchain",
    });
    registerToken({
      symbol: "DUP",
      name: "Dup Two",
      address: b,
      decimals: 6,
      fallbackUsd: 0,
      tint: tintForAddress(b),
      source: "onchain",
    });
    const r = resolveSymbol("DUP");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.matches.length).toBe(2);
      const addrs = r.matches.map((m) => m.address.toLowerCase()).sort();
      expect(addrs).toEqual([a.toLowerCase(), b.toLowerCase()]);
    }
  });

  it("reports NOT_FOUND for a ticker that exists nowhere", () => {
    const r = resolveSymbol("TOTALLY-MADE-UP-TOKEN-9");
    expect(r.status).toBe("not_found");
  });

  it("never resolves an empty query", () => {
    expect(resolveSymbol("").status).toBe("not_found");
  });
});
