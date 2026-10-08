/**
 * Paymaster provider types.
 *
 * A paymaster provider is the *only* thing allowed to declare that an ERC-20
 * can pay gas. Nothing in this codebase hardcodes a supported-token list: the
 * provider is queried at runtime and its answer is authoritative. A local token
 * registry may supply metadata (symbol/decimals), never a support claim.
 *
 * Every token is identified canonically by `chainId + normalized address`.
 * Symbols are display metadata and are never used to decide support — USDC on
 * one contract and a spoofed "USDC" at another address must never be confused.
 */

/** A gas token exactly as the provider reports it. */
export type PaymasterToken = {
  /** Monad mainnet chain id (143). */
  chainId: number;
  /** Normalized (lower-cased) contract address. */
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
};

/** Canonical identity key for a gas token. */
export function gasTokenKey(chainId: number, address: string): string {
  return `${chainId}:${(address ?? "").toLowerCase()}`;
}

/**
 * The result of asking a provider for its supported gas tokens.
 *
 * `ok: false` is a first-class outcome: discovery failed, so *no* token may be
 * claimed as supported. The caller must fall back to native MON gas rather than
 * assume anything.
 */
export type SupportedTokensResult =
  | { ok: true; tokens: PaymasterToken[]; at: number; source: string }
  | { ok: false; reason: string; at: number; source: string };

/** A paymaster quote for one UserOperation, in the chosen gas token. */
export type PaymasterQuote = {
  /** The gas token this quote is denominated in (canonical identity). */
  token: PaymasterToken;
  /** Estimated UserOperation gas (total), base units. */
  gasEstimate: bigint;
  /** Estimated token amount the user will spend on gas, base units. */
  tokenAmount: bigint;
  /** Token amount as a decimal string for display. */
  tokenAmountDecimal: string;
  /** The paymaster contract that will settle the fee. */
  paymaster: `0x${string}`;
  /** Opaque paymaster data to attach to the UserOperation. */
  paymasterData: `0x${string}`;
  /** Provider-supplied postOp verification gas limit, when present. */
  paymasterPostOpGasLimit?: bigint;
  paymasterVerificationGasLimit?: bigint;
  /** Oracle/fx information, when the provider exposes it (0n when unknown). */
  exchangeRate: bigint;
  /**
   * The provider's postOp gas overhead, base units. The ERC-20 fee covers the
   * UserOperation gas *plus* this postOp gas, so the approval bound must include
   * it or the postOp `transferFrom` reverts. 0n when the provider omitted it.
   */
  postOpGas?: bigint;
  /** ERC-20 storage slot of `balanceOf` (used only for simulation overrides). */
  balanceSlot?: bigint;
  /** ERC-20 storage slot of `allowance` (used only for simulation overrides). */
  allowanceSlot?: bigint;
  /** Unix seconds the quote is valid until, when known. */
  validUntil?: number;
  /** When this quote was produced (ms). Used for freshness. */
  at: number;
};

/**
 * The provider's live ERC-20 gas quote for a token — the fields needed to
 * compute the exact, bounded paymaster allowance (no UserOperation required).
 */
export type GasTokenQuote = {
  token: PaymasterToken;
  /** The paymaster contract that will settle the fee. */
  paymaster: `0x${string}`;
  /** Token base units per native base unit, scaled by 1e18. */
  exchangeRate: bigint;
  /** The provider's postOp gas overhead, base units. */
  postOpGas: bigint;
  /** ERC-20 storage slots (used only for simulation overrides). */
  balanceSlot?: bigint;
  allowanceSlot?: bigint;
  at: number;
};

/** A provider must answer these to be usable. */
export type PaymasterProvider = {
  /** Stable id, e.g. "pimlico". Surfaced in the capability UI. */
  readonly id: string;
  /** Whether the provider is configured (a server-side key is present). */
  configured(): boolean;
  /**
   * Discover the ERC-20 tokens the provider currently accepts for gas on the
   * given chain. Never throws; a failure is `{ ok: false }`.
   */
  supportedTokens(chainId: number): Promise<SupportedTokensResult>;
  /**
   * Obtain a fresh paymaster quote for a UserOperation paying gas in `token`.
   * Returns null when the provider cannot quote (unreachable, token rejected).
   */
  quote(input: {
    chainId: number;
    entryPoint: `0x${string}`;
    token: PaymasterToken;
    userOperation: Record<string, unknown>;
  }): Promise<PaymasterQuote | null>;
  /**
   * The live ERC-20 gas quote for a token (paymaster, exchange rate, postOp
   * gas), independent of any UserOperation. Used to compute the bounded
   * allowance. Returns null when the provider cannot quote.
   */
  gasQuote(input: { chainId: number; entryPoint: `0x${string}`; token: PaymasterToken }): Promise<GasTokenQuote | null>;
  /** Whether the provider answered a live health request on the chain. */
  reachable(chainId: number): Promise<{ reachable: boolean; error?: string }>;
};
