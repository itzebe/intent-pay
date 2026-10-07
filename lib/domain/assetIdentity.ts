import type { MonadNetwork } from "@/lib/config/chains";
import { getToken, getTokenByAddress, type TokenConfig } from "@/lib/config/tokens";

/**
 * Canonical asset identity.
 *
 * A token is identified by **(chain, contract address)** — never by symbol
 * alone. Symbol is display metadata derived from the resolved token record.
 * This is what prevents one asset's symbol from ever being shown next to
 * another asset's data (e.g. a hardcoded "AUSD" appearing while the selected,
 * quoted asset is USDT): every surface resolves its label through the same
 * keyed identity.
 */

/** The address that identifies the native asset in the registry. */
export const NATIVE_ASSET_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Stable key for an asset on a chain: `network:0xaddress`. */
export function assetKey(network: MonadNetwork, address: string): string {
  return `${network}:${(address ?? "").toLowerCase()}`;
}

/** Stable key for a token record. */
export function tokenAssetKey(network: MonadNetwork, token: TokenConfig): string {
  return assetKey(network, token.address);
}

/**
 * The canonical identity of an asset. The contract address is authoritative;
 * `symbol`/`name` are derived display fields. `id` is the (chain, address) key
 * every downstream layer should carry instead of a bare symbol.
 */
export type CanonicalAsset = {
  id: string;
  network: MonadNetwork;
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
  /** True when the asset is pooled in a wrapped form (WMON for native MON). */
  wrapped: boolean;
  source: string;
};

export function canonicalAsset(
  token: TokenConfig,
  network: MonadNetwork,
): CanonicalAsset {
  return {
    id: tokenAssetKey(network, token),
    network,
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    native: Boolean(token.native),
    wrapped: Boolean(token.native),
    source: token.source ?? "unknown",
  };
}

/**
 * Resolve an asset from an explicit identity (preferred) or a bare symbol
 * (legacy). Address wins when both are present, so a stale symbol can never
 * override the contract address the user actually selected.
 */
export function resolveAsset(
  network: MonadNetwork,
  ref: { address?: string; symbol?: string },
): CanonicalAsset | null {
  if (ref.address) {
    const byAddress = getTokenByAddressSafe(ref.address);
    if (byAddress) return canonicalAsset(byAddress, network);
  }
  if (ref.symbol) {
    const bySymbol = getToken(ref.symbol);
    if (bySymbol) return canonicalAsset(bySymbol, network);
  }
  return null;
}

/** Same asset identity? Compares (chain, address) — never symbol. */
export function sameAsset(a: CanonicalAsset | null, b: CanonicalAsset | null): boolean {
  return Boolean(a && b && a.id === b.id);
}

/**
 * Does `token` resolve to the asset `ref` identifies? Used to confirm a quote
 * or balance really refers to the selected asset rather than a same-symbol
 * token from a different chain/address.
 */
export function tokenMatchesRef(
  token: TokenConfig,
  ref: { address?: string; symbol?: string },
): boolean {
  if (ref.address) {
    return token.address.toLowerCase() === ref.address.toLowerCase();
  }
  if (ref.symbol) {
    return token.symbol.toLowerCase() === ref.symbol.toLowerCase();
  }
  return false;
}

/** Local import to avoid a cycle with the registry's own helpers. */
function getTokenByAddressSafe(address: string): TokenConfig | undefined {
  return getTokenByAddress(address);
}
