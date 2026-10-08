import { afterEach, describe, expect, it } from "vitest";
import {
  applySlippageIn,
  applySlippageOut,
  assessPriceImpact,
  DEFAULT_MAX_PRICE_IMPACT_BPS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  resolveExecutionProtection,
  resolveMevProtection,
  resolveSlippageBps,
} from "@/lib/domain/protection";

/**
 * The protection surface must be honest and enforced:
 *   - slippage is bounded and never widened to rescue a bad route,
 *   - price impact above the ceiling blocks,
 *   - MEV protection is only "active" when a private path is really configured.
 */

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SLIPPAGE_BPS;
  delete process.env.NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS;
  delete process.env.NEXT_PUBLIC_MEV_PROTECTED_RPC_URL;
});

describe("slippage tolerance", () => {
  it("defaults to a tight 0.5%", () => {
    expect(resolveSlippageBps()).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(DEFAULT_SLIPPAGE_BPS).toBe(50);
  });

  it("is hard-clamped at the ceiling — slippage can never be widened past 5%", () => {
    expect(resolveSlippageBps(9_999)).toBe(MAX_SLIPPAGE_BPS);
    expect(MAX_SLIPPAGE_BPS).toBe(500);
  });

  it("rejects a zero/negative/garbage request and falls back to the default", () => {
    expect(resolveSlippageBps(0)).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(resolveSlippageBps(-100)).toBe(DEFAULT_SLIPPAGE_BPS);
    expect(resolveSlippageBps(Number.NaN)).toBe(DEFAULT_SLIPPAGE_BPS);
  });

  it("honours an env override within the ceiling", () => {
    process.env.NEXT_PUBLIC_SLIPPAGE_BPS = "100";
    expect(resolveSlippageBps()).toBe(100);
  });

  it("derives a real minimum output: 1% below the quoted amount", () => {
    // 3861 MON expected, 1% slippage → 3822.39 MON floor.
    const expected = 3861n * 10n ** 18n;
    const min = applySlippageOut(expected, 100);
    expect(min).toBe((expected * 9900n) / 10000n);
    expect(min).toBeLessThan(expected);
  });

  it("derives a real maximum input for an exact-output swap", () => {
    const quotedIn = 1000n * 10n ** 6n;
    const max = applySlippageIn(quotedIn, 50);
    expect(max).toBe((quotedIn * 10050n) / 10000n);
    expect(max).toBeGreaterThan(quotedIn);
  });
});

describe("price-impact guard", () => {
  it("allows a route within the ceiling", () => {
    const a = assessPriceImpact(0.005); // 0.5%
    expect(a.ok).toBe(true);
    expect(a.blocked).toBe(false);
    expect(a.bps).toBe(50);
  });

  it("blocks a route above the ceiling", () => {
    const a = assessPriceImpact(0.05); // 5% > 3%
    expect(a.blocked).toBe(true);
    expect(a.ok).toBe(false);
  });

  it("uses the configured ceiling", () => {
    expect(assessPriceImpact(0.01).max).toBeCloseTo(DEFAULT_MAX_PRICE_IMPACT_BPS / 10_000);
    process.env.NEXT_PUBLIC_MAX_PRICE_IMPACT_BPS = "100";
    expect(assessPriceImpact(0.02).blocked).toBe(true);
  });

  it("does NOT block an unmeasurable impact (never invents a number)", () => {
    expect(assessPriceImpact(null).ok).toBe(true);
    expect(assessPriceImpact(undefined).blocked).toBe(false);
    expect(assessPriceImpact(Number.NaN).ok).toBe(true);
  });
});

describe("MEV / private order flow capability", () => {
  // L. Private/MEV-protected submission is unavailable → honest fallback.
  it("reports UNAVAILABLE and never claims protection from config alone (L)", () => {
    const mev = resolveMevProtection();
    expect(mev.state).toBe("MEV_PROTECTION_UNAVAILABLE");
    expect(mev.active).toBe(false);
    expect(mev.rpcConfigured).toBe(false);
  });

  it("stays UNAVAILABLE even when a private RPC URL is set in the environment", () => {
    // A dapp cannot force an injected wallet to broadcast privately, so a
    // configured URL must not flip the badge to "Active".
    process.env.NEXT_PUBLIC_MEV_PROTECTED_RPC_URL = "https://private.example/rpc";
    const mev = resolveMevProtection();
    expect(mev.state).toBe("MEV_PROTECTION_UNAVAILABLE");
    expect(mev.active).toBe(false);
  });
});

describe("combined execution protection", () => {
  it("always reports slippage protection active, with the clamped tolerance", () => {
    const p = resolveExecutionProtection(null, 9_999);
    expect(p.slippage.state).toBe("SLIPPAGE_PROTECTION_ACTIVE");
    expect(p.slippage.bps).toBe(MAX_SLIPPAGE_BPS);
  });

  it("carries the price-impact assessment and the MEV state together", () => {
    const p = resolveExecutionProtection(0.01);
    expect(p.priceImpact.value).toBe(0.01);
    expect(p.mev.state).toBe("MEV_PROTECTION_UNAVAILABLE");
  });
});
