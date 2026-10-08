import { describe, expect, it } from "vitest";
import {
  assessTokenRisk,
  isTokenExecutable,
  MIN_EXECUTABLE_LIQUIDITY_USD,
  type TokenRiskFacts,
} from "@/lib/domain/tokenRisk";

function facts(partial: Partial<TokenRiskFacts> = {}): TokenRiskFacts {
  return {
    decimals: 18,
    liquidityUsd: 250_000,
    priceImpact: 0.002,
    maxPriceImpact: 0.03,
    transferSim: { ok: true },
    hasRoute: true,
    ...partial,
  };
}

describe("token execution-risk assessment", () => {
  it("EXECUTION_SAFE only when every measured check passes", () => {
    const r = assessTokenRisk(facts());
    expect(r.state).toBe("EXECUTION_SAFE");
    expect(r.safe).toBe(true);
    expect(r.blocked).toBe(false);
    expect(isTokenExecutable(r)).toBe(true);
  });

  it("blocks a token with no route (never force an illiquid token)", () => {
    const r = assessTokenRisk(facts({ hasRoute: false }));
    expect(r.state).toBe("QUOTE_FAILED");
    expect(r.blocked).toBe(true);
  });

  it("blocks zero liquidity", () => {
    const r = assessTokenRisk(facts({ liquidityUsd: 0 }));
    expect(r.state).toBe("NO_LIQUIDITY");
    expect(r.blocked).toBe(true);
  });

  it("blocks liquidity below the executable minimum", () => {
    const r = assessTokenRisk(facts({ liquidityUsd: MIN_EXECUTABLE_LIQUIDITY_USD - 1 }));
    expect(r.state).toBe("INSUFFICIENT_LIQUIDITY");
    expect(r.blocked).toBe(true);
  });

  it("allows liquidity exactly at the minimum", () => {
    const r = assessTokenRisk(facts({ liquidityUsd: MIN_EXECUTABLE_LIQUIDITY_USD }));
    expect(r.state).toBe("EXECUTION_SAFE");
  });

  it("blocks a measured excessive price impact", () => {
    const r = assessTokenRisk(facts({ priceImpact: 0.078, maxPriceImpact: 0.01 }));
    expect(r.state).toBe("EXCESSIVE_PRICE_IMPACT");
    expect(r.blocked).toBe(true);
  });

  it("allows a small measured price impact", () => {
    const r = assessTokenRisk(facts({ priceImpact: 0.0018, maxPriceImpact: 0.01 }));
    expect(r.state).toBe("EXECUTION_SAFE");
  });

  it("blocks a token whose transfer simulation reverts", () => {
    const r = assessTokenRisk(facts({ transferSim: { ok: false, reason: "ERC20: transfer disabled" } }));
    expect(r.state).toBe("TRANSFER_FAILED");
    expect(r.blocked).toBe(true);
  });

  it("blocks implausible decimals", () => {
    const r = assessTokenRisk(facts({ decimals: 99 }));
    expect(r.state).toBe("ABNORMAL_DECIMALS");
    expect(r.blocked).toBe(true);
  });

  it("an UNMEASURED fact is unknown, never a failure (a transient RPC error must not block)", () => {
    const r = assessTokenRisk(
      facts({ liquidityUsd: null, priceImpact: null, transferSim: null }),
    );
    expect(r.state).toBe("EXECUTION_SAFE");
    expect(r.blocked).toBe(false);
    expect(r.checks.filter((c) => c.status === "unknown").length).toBe(3);
  });

  it("reports the check list with the measured values for transparency", () => {
    const r = assessTokenRisk(facts({ liquidityUsd: 250_000, priceImpact: 0.0018 }));
    const liquidity = r.checks.find((c) => c.name === "liquidity");
    const impact = r.checks.find((c) => c.name === "price_impact");
    expect(liquidity?.status).toBe("pass");
    expect(liquidity?.detail).toContain("250,000");
    expect(impact?.status).toBe("pass");
    expect(impact?.detail).toContain("0.18%");
  });

  it("names the true blocker when several checks fail (decimals before liquidity)", () => {
    const r = assessTokenRisk(facts({ decimals: -1, liquidityUsd: 0, hasRoute: false }));
    expect(r.state).toBe("ABNORMAL_DECIMALS");
  });

  it("carries a human reason whenever it blocks", () => {
    for (const f of [
      facts({ hasRoute: false }),
      facts({ liquidityUsd: 0 }),
      facts({ liquidityUsd: 10 }),
      facts({ priceImpact: 0.5, maxPriceImpact: 0.01 }),
      facts({ transferSim: { ok: false } }),
      facts({ decimals: 99 }),
    ]) {
      const r = assessTokenRisk(f);
      expect(r.blocked).toBe(true);
      expect(r.reason).toBeTruthy();
    }
  });
});
