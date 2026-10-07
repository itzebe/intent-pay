import type { TokenConfig } from "@/lib/config/tokens";
import { NATIVE_ASSET_ADDRESS } from "./assetIdentity";

/**
 * Wallet-abstraction capability model.
 *
 * Gas handling is *not* a boolean. A payment can be abstracted, unabstracted,
 * or blocked for a specific, nameable reason — and the UI must be able to say
 * exactly which. This module turns the configured infrastructure + the live
 * wallet capability probe + the selected asset into one deterministic state.
 *
 * Nothing here fabricates sponsorship: a token is only "abstractable" when a
 * paymaster service is configured, the wallet advertises it, and the token is
 * in the paymaster's supported set. Otherwise the honest answer is that the
 * user needs MON.
 */

export type AbstractionState =
  | "ABSTRACTION_AVAILABLE"
  | "ABSTRACTION_UNAVAILABLE"
  | "ABSTRACTION_UNSUPPORTED_TOKEN"
  | "ABSTRACTION_UNSUPPORTED_CHAIN"
  | "ABSTRACTION_UNSUPPORTED_WALLET"
  | "PAYMASTER_UNAVAILABLE"
  | "INSUFFICIENT_TOKEN_BALANCE"
  | "NATIVE_GAS_REQUIRED";

export type GasAssetOption = {
  /** ERC-20 gas payment (wallet charges the fee in the selected token). */
  erc20GasPayment: boolean;
  /** Paymaster sponsorship (the user pays no gas at all). */
  sponsored: boolean;
  /** Native MON fallback is always structurally available. */
  native: boolean;
};

export type AbstractionCapabilities = {
  /** The configured chain (Monad mainnet). */
  chainId: number;
  /** The chain this payment targets is supported by the paymaster config. */
  chainSupported: boolean;
  /** An Alchemy gas policy is configured server-side. */
  paymasterConfigured: boolean;
  /** The wallet advertises the EIP-5792 `paymasterService` capability. */
  walletSupportsPaymaster: boolean;
  /** The wallet advertises ERC-20 gas payment. */
  walletSupportsErc20Gas: boolean;
  /** The wallet can submit an atomic batch at all. */
  walletSupportsBatch: boolean;
  /**
   * Addresses the configured paymaster will sponsor. Empty = unknown/any;
   * when non-empty, a token outside it is honestly "unsupported token".
   */
  supportedTokens: string[];
};

export type AbstractionResult = {
  state: AbstractionState;
  /** Whether *some* abstraction path is genuinely available right now. */
  abstracted: boolean;
  gasOptions: GasAssetOption;
  /** Human-readable, honest explanation for the current state. */
  message: string;
};

const MON = NATIVE_ASSET_ADDRESS;

/** Is the selected asset sponsored by the configured paymaster? */
export function isTokenSponsored(
  token: TokenConfig,
  supportedTokens: string[],
): boolean {
  if (token.native) return false;
  if (supportedTokens.length === 0) return false; // unknown set ⇒ do not claim
  return supportedTokens.some((a) => a.toLowerCase() === token.address.toLowerCase());
}

/**
 * Resolve the abstraction state for a payment.
 *
 * Order matters: a chain/wallet/paymaster limitation is reported before a
 * per-token one, so the message names the true blocker.
 */
export function resolveAbstraction(
  token: TokenConfig,
  caps: AbstractionCapabilities,
): AbstractionResult {
  const nativeGas: GasAssetOption = { erc20GasPayment: false, sponsored: false, native: true };

  if (!caps.chainSupported) {
    return {
      state: "ABSTRACTION_UNSUPPORTED_CHAIN",
      abstracted: false,
      gasOptions: nativeGas,
      message: `Wallet abstraction isn't available on this network (chain ${caps.chainId}). Your wallet needs MON for network fees.`,
    };
  }

  if (!caps.paymasterConfigured) {
    return {
      state: "PAYMASTER_UNAVAILABLE",
      abstracted: false,
      gasOptions: nativeGas,
      message:
        "Wallet abstraction unavailable for this payment: no paymaster is configured for this deployment. Your wallet needs MON for network fees.",
    };
  }

  if (!caps.walletSupportsPaymaster && !caps.walletSupportsErc20Gas) {
    return {
      state: "ABSTRACTION_UNSUPPORTED_WALLET",
      abstracted: false,
      gasOptions: nativeGas,
      message:
        "Wallet abstraction unavailable for this payment: your wallet doesn't support sponsored (EIP-5792) gas. Your wallet needs MON for network fees.",
    };
  }

  // ERC-20 gas payment works for any non-native token the wallet accepts; it
  // does not depend on the paymaster's token list.
  if (caps.walletSupportsErc20Gas && !token.native) {
    return {
      state: "ABSTRACTION_AVAILABLE",
      abstracted: true,
      gasOptions: { erc20GasPayment: true, sponsored: caps.walletSupportsPaymaster, native: true },
      message: `Your wallet can pay the network fee in ${token.symbol} — no MON required.`,
    };
  }

  if (caps.walletSupportsPaymaster) {
    if (isTokenSponsored(token, caps.supportedTokens)) {
      return {
        state: "ABSTRACTION_AVAILABLE",
        abstracted: true,
        gasOptions: { erc20GasPayment: caps.walletSupportsErc20Gas, sponsored: true, native: true },
        message: "Network fee sponsored — no MON required.",
      };
    }
    // Paymaster is live but doesn't cover this token: honest, not fake.
    if (token.native) {
      return {
        state: "NATIVE_GAS_REQUIRED",
        abstracted: false,
        gasOptions: nativeGas,
        message: "You're paying with MON, so the network fee comes out of the same balance.",
      };
    }
    return {
      state: "ABSTRACTION_UNSUPPORTED_TOKEN",
      abstracted: false,
      gasOptions: nativeGas,
      message: `Wallet abstraction unavailable for ${token.symbol}: the paymaster doesn't sponsor it. Your wallet needs MON for network fees.`,
    };
  }

  return {
    state: "ABSTRACTION_UNAVAILABLE",
    abstracted: false,
    gasOptions: nativeGas,
    message:
      "Wallet abstraction unavailable for this payment. Your wallet needs MON for network fees.",
  };
}

/** The token the user will actually pay the network fee in. */
export function gasAssetSymbol(
  token: TokenConfig,
  result: AbstractionResult,
): string {
  if (result.gasOptions.sponsored) return "sponsored";
  if (result.gasOptions.erc20GasPayment) return token.symbol;
  return "MON";
}

export { MON as NATIVE_GAS_ASSET };
