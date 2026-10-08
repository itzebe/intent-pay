import type { TokenConfig } from "@/lib/config/tokens";

/**
 * Execution-risk assessment for a token.
 *
 * A newly launched token must never be assumed safe just because it has
 * metadata. Before a payment is allowed to proceed we combine the facts we can
 * actually measure — real pool liquidity, a real transfer simulation, a live
 * quote, the route's price impact — into one explicit state. We only ever block
 * on evidence we have; a fact we could not measure is reported as *unknown*,
 * never as a failure, so a transient RPC error can't masquerade as a bad token.
 *
 * This module is pure: the async probes live in `lib/server/tokenRisk.ts` and
 * feed their measured results in here, so the classification is unit-testable
 * without a network.
 */

export type TokenRiskState =
  | "EXECUTION_SAFE"
  | "NO_LIQUIDITY"
  | "INSUFFICIENT_LIQUIDITY"
  | "TRANSFER_FAILED"
  | "QUOTE_FAILED"
  | "EXCESSIVE_PRICE_IMPACT"
  | "ABNORMAL_DECIMALS";

/** The individual facts the assessment is built from. `null` = not measured. */
export type TokenRiskFacts = {
  decimals: number;
  /** Deepest-pool USD liquidity, or null when it could not be read. */
  liquidityUsd: number | null;
  /** Live route price impact (fraction), or null when not computable. */
  priceImpact: number | null;
  /** Configured ceiling for price impact (fraction). */
  maxPriceImpact: number;
  /**
   * Outcome of a real `eth_call` transfer simulation from the payer, or null
   * when it was not attempted / inconclusive. `ok: false` means the token's
   * transfer path reverted for a payer who *does* hold the balance.
   */
  transferSim: { ok: boolean; reason?: string } | null;
  /** Whether a live quote/route exists at all for the token. */
  hasRoute: boolean;
};

export type TokenRiskCheck = {
  name: "liquidity" | "transfer" | "route" | "price_impact" | "decimals";
  status: "pass" | "fail" | "unknown";
  /** Short human explanation with the measured value, when there is one. */
  detail: string;
};

export type TokenRiskReport = {
  state: TokenRiskState;
  /** True only when the token is genuinely safe to execute with. */
  safe: boolean;
  /** True when a hard, evidence-backed failure blocks execution. */
  blocked: boolean;
  checks: TokenRiskCheck[];
  /** Human-readable reason, when not safe. */
  reason?: string;
};

/** Pools below this depth cannot reliably fill a payment without huge impact. */
export const MIN_EXECUTABLE_LIQUIDITY_USD = Number(
  process.env.NEXT_PUBLIC_MIN_EXECUTABLE_LIQUIDITY_USD ?? "2000",
);

/** ERC-20 decimals outside this range cannot be represented safely. */
export const MAX_TOKEN_DECIMALS = 36;

/**
 * Classify a token's execution risk from measured facts.
 *
 * Order matters: an identity/decimals problem is reported before a liquidity
 * one, so the message names the true blocker.
 */
export function assessTokenRisk(facts: TokenRiskFacts): TokenRiskReport {
  const checks: TokenRiskCheck[] = [];

  // 1. Decimals must be representable.
  const decimalsOk =
    Number.isInteger(facts.decimals) && facts.decimals >= 0 && facts.decimals <= MAX_TOKEN_DECIMALS;
  checks.push({
    name: "decimals",
    status: decimalsOk ? "pass" : "fail",
    detail: decimalsOk ? `${facts.decimals} decimals` : `implausible decimals (${facts.decimals})`,
  });
  if (!decimalsOk) {
    return report("ABNORMAL_DECIMALS", checks, `This token reports an implausible decimals value.`);
  }

  // 2. A route must exist. No route is a hard block — we never force an
  //    illiquid token through the router.
  checks.push({
    name: "route",
    status: facts.hasRoute ? "pass" : "fail",
    detail: facts.hasRoute ? "live route available" : "no route found",
  });
  if (!facts.hasRoute) {
    return report("QUOTE_FAILED", checks, "No sufficiently liquid route is currently available.");
  }

  // 3. Liquidity depth (when measured). A microscopic pool is a hard block;
  //    an unmeasured depth is honestly "unknown", not a failure.
  if (facts.liquidityUsd === null) {
    checks.push({ name: "liquidity", status: "unknown", detail: "liquidity not measured" });
  } else if (facts.liquidityUsd <= 0) {
    checks.push({ name: "liquidity", status: "fail", detail: "pool reports zero liquidity" });
    return report("NO_LIQUIDITY", checks, "This token has no liquidity on Monad yet.");
  } else if (facts.liquidityUsd < MIN_EXECUTABLE_LIQUIDITY_USD) {
    checks.push({
      name: "liquidity",
      status: "fail",
      detail: `$${Math.round(facts.liquidityUsd).toLocaleString("en-US")} < $${MIN_EXECUTABLE_LIQUIDITY_USD.toLocaleString("en-US")} minimum`,
    });
    return report(
      "INSUFFICIENT_LIQUIDITY",
      checks,
      "This token's liquidity is too thin to execute safely.",
    );
  } else {
    checks.push({
      name: "liquidity",
      status: "pass",
      detail: `$${Math.round(facts.liquidityUsd).toLocaleString("en-US")} of liquidity`,
    });
  }

  // 4. Price impact must be within the configured ceiling. Unknown impact does
  //    not block (we never invent a number); a measured over-limit impact does.
  if (facts.priceImpact === null) {
    checks.push({ name: "price_impact", status: "unknown", detail: "not measurable" });
  } else if (facts.priceImpact > facts.maxPriceImpact) {
    checks.push({
      name: "price_impact",
      status: "fail",
      detail: `${(facts.priceImpact * 100).toFixed(2)}% > ${(facts.maxPriceImpact * 100).toFixed(2)}% limit`,
    });
    return report(
      "EXCESSIVE_PRICE_IMPACT",
      checks,
      "This route's price impact is too high to execute safely.",
    );
  } else {
    checks.push({
      name: "price_impact",
      status: "pass",
      detail: `${(facts.priceImpact * 100).toFixed(2)}%`,
    });
  }

  // 5. The token must actually be transferable. This is a *real* simulation
  //    (eth_call) from a payer who holds the balance — a revert here means the
  //    token's transfer path is broken/blocked, which must block execution.
  if (facts.transferSim === null) {
    checks.push({ name: "transfer", status: "unknown", detail: "not simulated" });
  } else if (!facts.transferSim.ok) {
    checks.push({
      name: "transfer",
      status: "fail",
      detail: facts.transferSim.reason ?? "transfer simulation reverted",
    });
    return report(
      "TRANSFER_FAILED",
      checks,
      "This token could not be transferred in a live simulation — it may be paused, blocked, or non-standard.",
    );
  } else {
    checks.push({ name: "transfer", status: "pass", detail: "transfer simulated on-chain" });
  }

  return report("EXECUTION_SAFE", checks);
}

function report(
  state: TokenRiskState,
  checks: TokenRiskCheck[],
  reason?: string,
): TokenRiskReport {
  const safe = state === "EXECUTION_SAFE";
  return {
    state,
    safe,
    // Only an evidence-backed failure blocks. `unknown` never does.
    blocked: !safe,
    checks,
    reason: safe ? undefined : reason,
  };
}

/** Convenience: is this token safe to execute with? */
export function isTokenExecutable(report: TokenRiskReport): boolean {
  return report.safe;
}

export type { TokenConfig };
