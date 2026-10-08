import { getTokenByAddress, normalizeTokenConfig, type TokenConfig } from "@/lib/config/tokens";
import { gasTokenKey, type PaymasterToken, type SupportedTokensResult } from "./types";

/**
 * Paymaster capability normalisation.
 *
 * Turns the provider's raw supported-token list into canonical token identities
 * and matches them against the app's local registry by **chainId + address**,
 * never by symbol. The provider is authoritative for support; the local
 * registry only supplies display metadata (and is cross-checked, not trusted).
 *
 * The most important property here: a discovery *failure* must never be
 * confused with an empty-but-successful result. `ok: false` yields zero tokens
 * and a named reason; the caller then falls back to native MON gas.
 */

export type NormalizedGasToken = {
  /** Chain the token is valid on (must equal the active chain). */
  chainId: number;
  /** Normalized contract address. */
  address: `0x${string}`;
  /** Provider-reported symbol (display only). */
  symbol: string;
  /** Provider-reported name (display only). */
  name: string;
  /** Provider-reported decimals — authoritative for scaling when present. */
  decimals: number;
  /** The app's canonical token config, when the address is known locally. */
  config?: TokenConfig;
  /** True when the local metadata disagreed with the provider's decimals. */
  metadataMismatch?: boolean;
};

export type GasTokenNormalization = {
  ok: boolean;
  /** Non-null only on failure — never assume support when this is set. */
  reason?: string;
  tokens: NormalizedGasToken[];
  source: string;
  at: number;
};

/**
 * Normalise a provider discovery result against the expected chain.
 *
 * `expectedChainId` is enforced: a token reported for another chain is dropped,
 * so a cross-chain address can never be selected as a Monad gas token.
 */
export function normalizeSupportedTokens(
  result: SupportedTokensResult,
  expectedChainId: number,
): GasTokenNormalization {
  if (!result.ok) {
    return { ok: false, reason: result.reason, tokens: [], source: result.source, at: result.at };
  }
  const tokens: NormalizedGasToken[] = [];
  for (const t of result.tokens) {
    if (t.chainId !== expectedChainId) continue;
    const config = getTokenByAddress(t.address);
    // When the local registry knows the token, prefer the *provider's* decimals
    // for support decisions but surface a mismatch — a wrong scale must never
    // silently mis-price a gas fee.
    const metadataMismatch = Boolean(config && config.decimals !== t.decimals);
    tokens.push({
      chainId: t.chainId,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      config,
      metadataMismatch,
    });
  }
  return { ok: true, tokens, source: result.source, at: result.at };
}

/** Whether a specific contract address is a supported gas token. */
export function isSupportedGasToken(
  normalized: NormalizedGasToken[],
  chainId: number,
  address: string,
): boolean {
  const key = gasTokenKey(chainId, address);
  return normalized.some((t) => gasTokenKey(t.chainId, t.address) === key);
}

/** Find a supported gas token by canonical identity. */
export function findGasToken(
  normalized: NormalizedGasToken[],
  chainId: number,
  address: string,
): NormalizedGasToken | undefined {
  const key = gasTokenKey(chainId, address);
  return normalized.find((t) => gasTokenKey(t.chainId, t.address) === key);
}

/**
 * Report a supported gas token as the app's `TokenConfig`, filling display
 * fields from the provider when the local registry has no record. Uses the
 * provider's decimals so the identity is exactly what the paymaster accepts.
 */
export function gasTokenConfig(t: NormalizedGasToken): TokenConfig {
  if (t.config && !t.metadataMismatch) return t.config;
  return normalizeTokenConfig({
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    source: "list",
  });
}

export type { PaymasterToken };
