import { parseUnits } from "@/lib/domain/math";

/**
 * Deterministic ERC-20 gas-token selection.
 *
 * Pure and total: no React, no network. The caller supplies the provider's
 * supported set (the authoritative source), the user's authoritative on-chain
 * balances, and a gas estimate. The selector decides which token (if any) will
 * pay the network fee — and, crucially, *why not* when none can.
 *
 * The gas token is NOT the payment source token. They may coincide, but this
 * module never conflates them: `sourceSymbol` is only used as a tie-breaker
 * (a gas token equal to the source needs no extra conversion).
 *
 * A token is viable only when ALL hold:
 *   1. the active Paymaster supports it (canonical chain+address identity),
 *   2. it belongs to the active chain,
 *   3. the user holds a non-zero balance,
 *   4. the balance covers the estimated gas amount,
 *   5. the paymaster can currently quote it (producer passes quoteKnown).
 * Support is never inferred from the wallet or from a symbol.
 */

/** A candidate gas token, already normalised by the provider layer. */
export type GasTokenCandidate = {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** The active chain — a candidate on another chain is never viable. */
  /** Estimated token cost of gas, base units (0n when unknown). */
  estimatedCost?: bigint;
  /** The user's on-chain balance, base units (0n when none). */
  balance?: bigint;
  /** The provider can currently quote this token (defaults to true). */
  quoteKnown?: boolean;
  /** A trustworthy live USD price exists for this token. */
  priceKnown?: boolean;
  /** Effective USD gas cost, when priceable (used only for ranking). */
  costUsd?: number;
  /** The token is a stablecoin (preferred when otherwise equivalent). */
  stablecoin?: boolean;
};

export type GasSelectionInput = {
  /** Canonical gas-token identity keys the paymaster supports, `chainId:addr`. */
  supportedKeys: Set<string>;
  /** Active chain id (must match every candidate). */
  chainId: number;
  /** Candidates (usually = supported tokens the wallet might hold). */
  candidates: GasTokenCandidate[];
  /** The user's explicit gas-token address, when they chose one. */
  explicitAddress?: string | null;
  /** The payment source asset symbol, used as a "no extra conversion" bonus. */
  sourceSymbol?: string | null;
  /** Whether an ERC-20 gas path is available at all (provider + wallet). */
  paymasterAvailable: boolean;
  /** Whether the connected wallet can deliver an ERC-20-gas UserOperation. */
  walletCompatible: boolean;
};

export type GasSelectionCode =
  | "explicit_selected"
  | "auto_best"
  | "provider_unavailable"
  | "paymaster_unavailable"
  | "wallet_incompatible"
  | "token_unsupported"
  | "insufficient_balance"
  | "quote_unavailable"
  | "native_required";

export type GasSelectionResult = {
  selected: GasTokenCandidate | null;
  /** Every viable token, best-first (for the "pay with" UI). */
  viable: GasTokenCandidate[];
  code: GasSelectionCode;
  /** Deterministic, human-readable explanation. */
  reason: string;
  /** True when the user must supply MON because no ERC-20 path applies. */
  nativeRequired: boolean;
  /** When the user's explicit choice was rejected, why. */
  explicitIssue?: GasSelectionCode;
};

/** Canonical identity key (chain + normalized address). */
export function candidateKey(chainId: number, address: string): string {
  return `${chainId}:${(address ?? "").toLowerCase()}`;
}

function addressEq(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && a!.toLowerCase() === b.toLowerCase();
}

/** True when the user holds and can cover the estimated gas in this token. */
export function isViable(c: GasTokenCandidate, supportedKeys: Set<string>, chainId: number): boolean {
  if (c.chainId !== chainId) return false;
  if (!supportedKeys.has(candidateKey(c.chainId, c.address))) return false;
  const balance = c.balance ?? 0n;
  if (balance <= 0n) return false;
  // The estimated cost is an upper bound (maxFeePerGas is a ceiling), so a
  // balance equal to the estimate is sufficient.
  const cost = c.estimatedCost ?? 0n;
  if (cost > 0n && balance < cost) return false;
  // A token the provider cannot currently quote is not executable.
  if (c.quoteKnown === false) return false;
  return true;
}

/**
 * Deterministic ranking of viable candidates, best-first.
 *
 * Order (matching the product rules):
 *   - lowest effective USD cost (when both sides are priceable),
 *   - price-known before price-unknown (lower quote uncertainty),
 *   - no extra conversion (gas == source) before a conversion,
 *   - stablecoin before non-stablecoin,
 *   - then a stable address tie-breaker.
 *
 * Every comparison is on concrete values, so the result never depends on the
 * order the provider happened to return.
 */
export function rankViable(
  viable: GasTokenCandidate[],
  sourceSymbol?: string | null,
): GasTokenCandidate[] {
  const src = (sourceSymbol ?? "").toLowerCase();
  return [...viable].sort((a, b) => {
    // 1. Effective USD cost — only when both are priceable; otherwise fall
    //    through so we never compare a known cost against an unknown one.
    const aUsd = a.priceKnown && Number.isFinite(a.costUsd) ? (a.costUsd as number) : undefined;
    const bUsd = b.priceKnown && Number.isFinite(b.costUsd) ? (b.costUsd as number) : undefined;
    if (aUsd !== undefined && bUsd !== undefined && aUsd !== bUsd) return aUsd - bUsd;
    // 2. Lower quote uncertainty: price-known wins.
    if (a.priceKnown !== b.priceKnown) return a.priceKnown ? -1 : 1;
    // 3. Lowest additional conversion overhead: gas == source wins.
    const aConv = src && a.symbol.toLowerCase() === src ? 0 : 1;
    const bConv = src && b.symbol.toLowerCase() === src ? 0 : 1;
    if (aConv !== bConv) return aConv - bConv;
    // 4. Stablecoin preference when otherwise equivalent.
    if (Boolean(a.stablecoin) !== Boolean(b.stablecoin)) return a.stablecoin ? -1 : 1;
    // 5. Deterministic address tie-breaker — never provider order.
    return a.address.toLowerCase().localeCompare(b.address.toLowerCase());
  });
}

/**
 * Select the gas-payment token. Deterministic for identical inputs.
 *
 * An explicit user choice is honoured only when that exact token is viable; it
 * is never silently swapped for another token. When it is not viable we return
 * the precise reason and let the caller offer other supported tokens.
 */
export function selectGasPaymentToken(input: GasSelectionInput): GasSelectionResult {
  const { supportedKeys, chainId, candidates, explicitAddress, sourceSymbol } = input;

  // Provider/wallet gates come first so the message names the true blocker.
  if (!input.paymasterAvailable) {
    return native("provider_unavailable", "No ERC-20 gas paymaster is configured for this network.");
  }
  if (!input.walletCompatible) {
    return native("wallet_incompatible", "Your wallet cannot submit an account-abstraction transaction.");
  }

  const viable = rankViable(
    candidates.filter((c) => isViable(c, supportedKeys, chainId)),
    sourceSymbol,
  );

  // Explicit choice: honour it if (and only if) it is viable.
  if (explicitAddress) {
    const chosen = candidates.find((c) => addressEq(explicitAddress, c.address));
    if (!chosen || chosen.chainId !== chainId) {
      return {
        ...native("token_unsupported", "That token isn't a supported gas token on Monad."),
        explicitIssue: "token_unsupported",
      };
    }
    if (!supportedKeys.has(candidateKey(chosen.chainId, chosen.address))) {
      return {
        selected: null,
        viable,
        code: "token_unsupported",
        reason: `The paymaster doesn't accept ${chosen.symbol} for gas. Choose another gas token.`,
        nativeRequired: false,
        explicitIssue: "token_unsupported",
      };
    }
    if (chosen.quoteKnown === false) {
      return {
        selected: null,
        viable,
        code: "quote_unavailable",
        reason: `A live gas quote for ${chosen.symbol} isn't available right now. Choose another gas token.`,
        nativeRequired: false,
        explicitIssue: "quote_unavailable",
      };
    }
    if (!isViable(chosen, supportedKeys, chainId)) {
      return {
        selected: null,
        viable,
        code: "insufficient_balance",
        reason: `Your ${chosen.symbol} balance doesn't cover the estimated gas. Choose another gas token.`,
        nativeRequired: viable.length === 0,
        explicitIssue: "insufficient_balance",
      };
    }
    return {
      selected: chosen,
      viable,
      code: "explicit_selected",
      reason: `You chose ${chosen.symbol} to pay the network fee.`,
      nativeRequired: false,
    };
  }

  // AUTO: best viable token.
  const best = viable[0];
  if (best) {
    return {
      selected: best,
      viable,
      code: "auto_best",
      reason: best.priceKnown
        ? `Best available gas token: ${best.symbol}.`
        : `Gas will be paid in ${best.symbol}.`,
      nativeRequired: false,
    };
  }

  // No viable token. Distinguish "nothing supported" from "supported but no
  // quote" from "nothing funded" — each has a different fix.
  const anySupported = candidates.some(
    (c) => c.chainId === chainId && supportedKeys.has(candidateKey(c.chainId, c.address)),
  );
  if (!anySupported) {
    return native(
      "token_unsupported",
      "Your wallet doesn't hold a token the configured gas paymaster supports.",
    );
  }
  const heldUnquoted = candidates.some(
    (c) =>
      c.chainId === chainId &&
      supportedKeys.has(candidateKey(c.chainId, c.address)) &&
      (c.balance ?? 0n) > 0n &&
      c.quoteKnown === false,
  );
  if (heldUnquoted) {
    return native(
      "quote_unavailable",
      "A live gas quote isn't available for the supported token you hold. Native MON gas is required.",
    );
  }
  return native(
    "insufficient_balance",
    "Your balance doesn't cover the estimated gas in any supported token.",
  );
}

function native(code: GasSelectionCode, reason: string): GasSelectionResult {
  return { selected: null, viable: [], code, reason, nativeRequired: true };
}

/** Convenience for tests: parse a decimal estimate to base units. */
export function estimateFromDecimal(decimal: string, decimals: number): bigint {
  try {
    return parseUnits(decimal, decimals);
  } catch {
    return 0n;
  }
}
