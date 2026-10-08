import type { GasSelectionResult, GasTokenCandidate } from "./gasToken";

/**
 * Wallet-abstraction capability.
 *
 * One canonical, honest description of whether an ERC-20 can pay this
 * transaction's gas, and exactly which one. The UI never branches on a boolean:
 * it reads `mode` + `reason`, so "the paymaster is unavailable", "your wallet
 * can't do this" and "you don't hold a supported token" are distinct, nameable
 * states rather than one vague "unavailable".
 *
 * This module is pure (client- and server-safe) so the same rules produce the
 * same capability everywhere, and can be unit-tested without a wallet.
 */

export type GasPaymentMode = "ERC20_PAYMASTER" | "NATIVE" | "UNAVAILABLE";

/** Why abstraction is not available — a specific, actionable state. */
export type AbstractionReasonCode =
  | "provider_unavailable" // no paymaster configured for this chain
  | "provider_error" // provider configured but unreachable / discovery failed
  | "wallet_incompatible" // the connected wallet cannot submit an AA tx
  | "token_unsupported" // the wallet holds only tokens the paymaster rejects
  | "insufficient_balance" // a supported token is held but can't cover gas
  | "quote_unavailable" // supported + funded, but no live fee quote yet
  | "native_required" // no ERC-20 path; MON will pay the fee
  | "unavailable"; // abstraction genuinely not offered here

export type SupportedGasTokenView = {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** The wallet holds it. */
  held: boolean;
  /** Held balance as a decimal string (0 when none). */
  balance: string;
  /** The balance covers the estimated gas. */
  sufficientBalance: boolean;
  /** The provider can currently quote it. */
  quoteKnown: boolean;
  /** Estimated token cost of gas, base units (null when unknown). */
  estimatedFee: string | null;
  /** Estimated USD cost, when the token is priceable. */
  estimatedFeeUsd: string | null;
  /** This token is the selected gas token. */
  selected: boolean;
};

export type WalletAbstractionCapability = {
  /** True only when an ERC-20 will genuinely pay this transaction's gas. */
  available: boolean;
  mode: GasPaymentMode;
  /** The active provider id, or null when none applies. */
  provider: string | null;
  chainId: number;
  /** Address derived from the connected EOA (7702 keeps the same address). */
  account: `0x${string}` | null;
  /** Every token the paymaster accepts on this chain, with per-token status. */
  supportedGasTokens: SupportedGasTokenView[];
  /** The token that will pay gas, when one was selected. */
  selectedGasToken: SupportedGasTokenView | null;
  /** Machine code for the current state. */
  code: AbstractionReasonCode;
  /** Human-readable, honest explanation. */
  reason: string | null;
};

export type WalletAbstractionInput = {
  chainId: number;
  /** A paymaster provider is configured (a key is present). */
  providerConfigured: boolean;
  /** The provider answered (discovery succeeded). */
  providerReachable: boolean;
  /** Provider discovery failed with this reason. */
  providerError?: string | null;
  providerId?: string | null;
  /** The wallet can sign/submit the required 7702 UserOperation. */
  walletCompatible: boolean;
  /** The connected account (same address under EIP-7702). */
  account?: `0x${string}` | null;
  /** The deterministic gas-token selection result. */
  selection: GasSelectionResult;
  /** All supported gas tokens with their per-token status, for the UI. */
  supportedGasTokens?: SupportedGasTokenView[];
};

/** Map a selection failure code onto the capability reason code. */
function reasonFromSelection(selection: GasSelectionResult): AbstractionReasonCode {
  switch (selection.code) {
    case "explicit_selected":
    case "auto_best":
      return "native_required";
    case "provider_unavailable":
      return "provider_unavailable";
    case "paymaster_unavailable":
      return "provider_unavailable";
    case "wallet_incompatible":
      return "wallet_incompatible";
    case "token_unsupported":
      return "token_unsupported";
    case "insufficient_balance":
      return "insufficient_balance";
    case "quote_unavailable":
      return "quote_unavailable";
    case "native_required":
      return "native_required";
    default:
      return "unavailable";
  }
}

/**
 * Resolve the wallet-abstraction capability.
 *
 * Gate order matters so the message names the *true* first blocker:
 *   1. provider configured?            → provider_unavailable
 *   2. provider discovery succeeded?   → provider_error
 *   3. wallet can deliver AA?          → wallet_incompatible
 *   4. a token selected?               → ERC20_PAYMASTER
 *   5. otherwise                       → the selection's own specific reason
 */
export function resolveWalletAbstraction(
  input: WalletAbstractionInput,
): WalletAbstractionCapability {
  const base = {
    chainId: input.chainId,
    provider: input.providerId ?? null,
    account: input.account ?? null,
    supportedGasTokens: input.supportedGasTokens ?? [],
  };

  if (!input.providerConfigured) {
    return {
      ...base,
      available: false,
      mode: "UNAVAILABLE",
      selectedGasToken: null,
      code: "provider_unavailable",
      reason: "No ERC-20 gas paymaster is configured for this network.",
    };
  }

  if (!input.providerReachable) {
    return {
      ...base,
      available: false,
      mode: "UNAVAILABLE",
      selectedGasToken: null,
      code: "provider_error",
      reason: `Gas paymaster unreachable${input.providerError ? `: ${input.providerError}` : ""}. Native MON gas is required.`,
    };
  }

  if (!input.walletCompatible) {
    return {
      ...base,
      available: false,
      mode: "NATIVE",
      selectedGasToken: null,
      code: "wallet_incompatible",
      reason:
        "Wallet abstraction unavailable for this wallet: it cannot sign an account-abstraction transaction. Native MON gas is required.",
    };
  }

  const selected = input.selection.selected;
  if (selected) {
    const view = (input.supportedGasTokens ?? []).find((t) => t.selected);
    return {
      ...base,
      available: true,
      mode: "ERC20_PAYMASTER",
      selectedGasToken: view ?? null,
      code: "native_required",
      reason: input.selection.reason,
    };
  }

  // No token selected: report the specific reason and fall back to MON.
  const code = reasonFromSelection(input.selection);
  return {
    ...base,
    available: false,
    mode: "NATIVE",
    selectedGasToken: null,
    code,
    reason: input.selection.reason,
  };
}

/** The per-token view the capability API exposes (see section 14). */
export type GasPaymentTokenCapability = {
  supported: boolean;
  sufficientBalance: boolean;
  estimatedFee: string | null;
  estimatedFeeUsd: string | null;
  reason: string | null;
};

/** Build a per-token `gasPayment` capability entry for the API. */
export function gasPaymentForToken(
  token: { symbol: string; held: boolean; sufficientBalance: boolean; quoteKnown: boolean; estimatedFee: string | null; estimatedFeeUsd: string | null },
  supported: boolean,
): GasPaymentTokenCapability {
  if (!supported) {
    return {
      supported: false,
      sufficientBalance: false,
      estimatedFee: null,
      estimatedFeeUsd: null,
      reason: `The configured paymaster doesn't accept ${token.symbol} for gas on Monad.`,
    };
  }
  if (!token.held) {
    return { supported: true, sufficientBalance: false, estimatedFee: null, estimatedFeeUsd: null, reason: `You don't hold ${token.symbol}.` };
  }
  if (!token.sufficientBalance) {
    return {
      supported: true,
      sufficientBalance: false,
      estimatedFee: token.estimatedFee,
      estimatedFeeUsd: token.estimatedFeeUsd,
      reason: `Your ${token.symbol} balance doesn't cover the estimated gas.`,
    };
  }
  if (!token.quoteKnown) {
    return {
      supported: true,
      sufficientBalance: true,
      estimatedFee: token.estimatedFee,
      estimatedFeeUsd: token.estimatedFeeUsd,
      reason: `A live gas quote for ${token.symbol} isn't available yet.`,
    };
  }
  return {
    supported: true,
    sufficientBalance: true,
    estimatedFee: token.estimatedFee,
    estimatedFeeUsd: token.estimatedFeeUsd,
    reason: null,
  };
}

export type { GasSelectionResult, GasTokenCandidate };
