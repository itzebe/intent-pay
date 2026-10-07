import { describe, expect, it } from "vitest";
import {
  assetKey,
  canonicalAsset,
  resolveAsset,
  sameAsset,
  tokenMatchesRef,
} from "@/lib/domain/assetIdentity";
import { getToken } from "@/lib/config/tokens";
import { reduceIntent, initialIntent, receiveTokenOf, payTokenOf } from "@/lib/domain/canonicalIntent";

const USDC = getToken("USDC")!;
const USDT = getToken("USDT")!;
const AUSD = getToken("AUSD")!;

/**
 * Asset identity is (chain, contract address) — never symbol. These tests pin
 * the invariant behind the production bug where an "I spend" amount labelled
 * "in AUSD" was really paid in USDT.
 */
describe("canonical asset identity", () => {
  it("keys an asset by network + address", () => {
    expect(assetKey("mainnet", USDC.address)).toBe(`mainnet:${USDC.address.toLowerCase()}`);
    expect(assetKey("mainnet", USDT.address)).not.toBe(assetKey("mainnet", USDC.address));
  });

  it("resolves by address in preference to a stale symbol", () => {
    const asset = resolveAsset("mainnet", { address: AUSD.address, symbol: "USDT" });
    expect(asset?.symbol).toBe("AUSD");
    expect(asset?.id).toBe(assetKey("mainnet", AUSD.address));
  });

  it("falls back to the symbol only when no address is given", () => {
    const asset = resolveAsset("mainnet", { symbol: "USDT" });
    expect(asset?.symbol).toBe("USDT");
  });

  it("treats two different tokens with different addresses as different assets", () => {
    const a = canonicalAsset(USDT, "mainnet");
    const b = canonicalAsset(AUSD, "mainnet");
    expect(sameAsset(a, b)).toBe(false);
    expect(sameAsset(a, canonicalAsset(USDT, "mainnet"))).toBe(true);
  });

  it("matches a token against a ref by address, not symbol", () => {
    expect(tokenMatchesRef(USDT, { address: USDT.address })).toBe(true);
    // A USD-anchor symbol must not match a different token's address.
    expect(tokenMatchesRef(AUSD, { address: USDT.address })).toBe(false);
  });
});

/**
 * The canonical intent must record the contract address alongside the symbol
 * so the two can never drift. A change to either — even with the same symbol —
 * must invalidate any prior quote.
 */
describe("canonical intent asset address", () => {
  it("resolves the intent's asset by its recorded address", () => {
    const intent = reduceIntent(initialIntent(), {
      receiveToken: "AUSD",
      receiveTokenAddress: AUSD.address,
    });
    expect(receiveTokenOf(intent)?.symbol).toBe("AUSD");
    expect(receiveTokenOf(intent)?.address).toBe(AUSD.address);
  });

  it("bumps the version when only the address changes (same symbol)", () => {
    const base = reduceIntent(initialIntent(), {
      payToken: "USDT",
      payTokenAddress: USDT.address,
    });
    const moved = reduceIntent(base, { payTokenAddress: AUSD.address });
    expect(moved.version).toBeGreaterThan(base.version);
    expect(moved.key).not.toBe(base.key);
  });

  it("falls back to the symbol when no address was recorded", () => {
    const intent = reduceIntent(initialIntent(), { payToken: "USDT", payTokenAddress: undefined });
    expect(payTokenOf(intent)?.symbol).toBe("USDT");
  });
});
