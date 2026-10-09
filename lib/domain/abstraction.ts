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
  | "POLICY_UNAVAILABLE"
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
  /**
   * A gas policy id is present. When `policyUsable` is false the policy exists
   * but cannot be used right now (expired / out of scope).
   */
  paymasterConfigured: boolean;
  /**
   * The configured policy is genuinely usable right now. Defaults to
   * `paymasterConfigured` when omitted so a caller that only knows "a policy is
   * configured" is not silently downgraded.
   */
  policyUsable?: boolean;
  /** Why the policy is not usable (shown to the user when relevant). */
  policyReason?: string;
  /**
   * An ERC-20 gas provider (e.g. Pimlico) is configured. This is a paymaster in
   * its own right — it lets a wallet with no MON pay the fee in a token — so it
   * must count as "a paymaster is configured". Omitting it preserves the
   * Alchemy-only behaviour for existing callers.
   */
  erc20ProviderConfigured?: boolean;
  /** The ERC-20 provider answered a live probe on this chain. */
  erc20ProviderAvailable?: boolean;
  /** The precise per-wallet ERC-20 reason (from the live capability probe). */
  erc20ProviderReason?: string | null;
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
    // An ERC-20 gas provider (Pimlico) is a paymaster in its own right. When it
    // is configured the app must NOT claim "no paymaster is configured" — the
    // honest state depends on the live probe and the wallet.
    if (caps.erc20ProviderConfigured) {
      if (caps.erc20ProviderAvailable === false) {
        return {
          state: "PAYMASTER_UNAVAILABLE",
          abstracted: false,
          gasOptions: nativeGas,
          message: `Gas abstraction is configured but unavailable right now${caps.erc20ProviderReason ? `: ${caps.erc20ProviderReason}` : "."} Your wallet needs MON for network fees.`,
        };
      }
      if (!caps.walletSupportsErc20Gas) {
        return {
          state: "ABSTRACTION_UNSUPPORTED_WALLET",
          abstracted: false,
          gasOptions: nativeGas,
          message:
            "Gas abstraction is configured, but this wallet can't pay the network fee in an ERC-20. Your wallet needs MON for network fees.",
        };
      }
      // The provider is configured, reachable and the wallet can deliver it, but
      // no supported+funded token was selected for this payment yet.
      return {
        state: "INSUFFICIENT_TOKEN_BALANCE",
        abstracted: false,
        gasOptions: { erc20GasPayment: true, sponsored: false, native: true },
        message:
          caps.erc20ProviderReason ??
          "Pay the network fee in a token you hold — no MON required.",
      };
    }
    return {
      state: "PAYMASTER_UNAVAILABLE",
      abstracted: false,
      gasOptions: nativeGas,
      message:
        "Wallet abstraction unavailable for this payment: no paymaster is configured for this deployment. Your wallet needs MON for network fees.",
    };
  }

  // A policy exists but is not usable right now (expired / outside its window).
  // Sponsorship is not claimed, and the reason is named rather than generic.
  const policyUsable = caps.policyUsable ?? true;
  if (!policyUsable) {
    return {
      state: "POLICY_UNAVAILABLE",
      abstracted: false,
      gasOptions: nativeGas,
      message: `Wallet abstraction unavailable for this payment: ${caps.policyReason ?? "the configured gas policy is not usable right now."} Your wallet needs MON for network fees.`,
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
