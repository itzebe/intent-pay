/**
 * The single, honest source of the "network fee" warning shown on the composer.
 *
 * The bug this replaces: when gas abstraction was configured and the connected
 * wallet could use it, but the live per-payment capability had not (yet)
 * selected a funded gas token, the composer still printed
 *   "You need a small amount of MON for network fees … Your wallet needs MON."
 * even while the same screen advertised ERC-20 gas payment. That self-
 * contradiction is what a 0-MON user saw.
 *
 * The rule: only demand native MON when no ERC-20 gas path is offered at all.
 * When one is offered, name the real blocker (a funded/supported gas token) and
 * never word the message as though the paymaster were absent.
 */

export type GasWarningInput = {
  /** Estimated fee in MON, for the native path. */
  requiredMon: string;
  /** The wallet's MON balance. */
  availableMon: string;
  /** A live ERC-20 gas path is offered for this payment (not yet selected). */
  erc20GasOffered: boolean;
  /** The precise, honest reason an ERC-20 can't cover it right now (optional). */
  reason?: string | null;
};

export type GasWarning = {
  title: string;
  detail: string;
  /** True only when the wallet genuinely must hold MON to proceed. */
  nativeRequired: boolean;
};

export function nativeGasWarning(input: GasWarningInput): GasWarning {
  if (input.erc20GasOffered) {
    return {
      nativeRequired: false,
      title: "Network fee needs a gas token",
      detail:
        input.reason ??
        "This payment's network fee can't be covered by a supported token in your wallet right now. Add a supported gas token, or hold a little MON to pay the fee in MON.",
    };
  }
  return {
    nativeRequired: true,
    title: "Network fee needs MON",
    detail: `You need about ${input.requiredMon} MON for network fees. Your wallet holds ${input.availableMon} MON.`,
  };
}
