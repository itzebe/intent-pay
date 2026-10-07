import type { MonadNetwork } from "@/lib/config/chains";
import type { TokenConfig } from "@/lib/config/tokens";
import { getRoutingProvider } from "@/lib/providers";
import { getPriceResolver } from "@/lib/server/pricing";

/**
 * Token state model.
 *
 * The central honesty rule of Intent Pay: *a token existing is not the same as
 * a token being payable*. A contract can exist, expose metadata, and still be
 * unusable as a payment asset because no trustworthy price or no liquidity
 * route exists. We make that distinction explicit instead of letting a token
 * that merely "resolves" look payable.
 *
 *   UNKNOWN             — we could not even identify it (no code / bad address)
 *   DISCOVERED          — contract exists, metadata resolved
 *   PRICE_AVAILABLE     — a trustworthy USD price exists
 *   PRICE_UNAVAILABLE   — it exists, but we have no price (never shown as $0.00)
 *   ROUTE_AVAILABLE     — a route exists from some anchor to this token
 *   ROUTE_UNAVAILABLE   — probed, no usable route
 *   PAYABLE             — DISCOVERED + price + route: it can satisfy a payment
 */
export type TokenState =
  | "UNKNOWN"
  | "DISCOVERED"
  | "PRICE_AVAILABLE"
  | "PRICE_UNAVAILABLE"
  | "ROUTE_AVAILABLE"
  | "ROUTE_UNAVAILABLE"
  | "PAYABLE";

/** Ordered "capability" facts about a token, from which the state is derived. */
export type TokenCapabilities = {
  /** A contract with code exists (or it is the native asset). */
  exists: boolean;
  /** Metadata (symbol/name/decimals) resolved. */
  identified: boolean;
  /** A trustworthy USD price exists. */
  priced: boolean;
  /** Probed and a usable route exists. */
  routable: boolean;
  /** The routability probe actually ran (false => `routable` is unknown). */
  routeProbed: boolean;
};

/** Derive the single canonical state from the underlying facts. */
export function deriveTokenState(c: TokenCapabilities): TokenState {
  if (!c.exists || !c.identified) return "UNKNOWN";
  if (!c.priced) return "PRICE_UNAVAILABLE";
  if (!c.routeProbed) return "PRICE_AVAILABLE";
  if (!c.routable) return "ROUTE_UNAVAILABLE";
  return "PAYABLE";
}

/** Every state a token currently satisfies (the derivation is cumulative). */
export function tokenStateFlags(c: TokenCapabilities): TokenState[] {
  const flags: TokenState[] = [];
  if (!c.exists || !c.identified) return ["UNKNOWN"];
  flags.push("DISCOVERED");
  flags.push(c.priced ? "PRICE_AVAILABLE" : "PRICE_UNAVAILABLE");
  if (c.routeProbed) {
    flags.push(c.routable ? "ROUTE_AVAILABLE" : "ROUTE_UNAVAILABLE");
    if (c.routable && c.priced) flags.push("PAYABLE");
  }
  return flags;
}

/** Human copy for a state, used by the UI. */
export function tokenStateLabel(state: TokenState): string {
  switch (state) {
    case "PAYABLE":
      return "Payable";
    case "ROUTE_UNAVAILABLE":
      return "No route";
    case "PRICE_UNAVAILABLE":
      return "Price unavailable";
    case "PRICE_AVAILABLE":
      return "Priced";
    case "DISCOVERED":
      return "Discovered";
    default:
      return "Unknown";
  }
}

export type TokenIntelligence = {
  state: TokenState;
  flags: TokenState[];
  capabilities: TokenCapabilities;
  /** True when this token can currently satisfy a payment. */
  payable: boolean;
  price: {
    usd: number | null;
    source: string;
    label: string;
    /** Price freshness: LIVE / STALE / UNAVAILABLE. */
    status: "LIVE" | "STALE" | "UNAVAILABLE";
  } | null;
};

/**
 * Compute the full intelligence record for a token.
 *
 * `routable` is tri-state: `true`/`false` come from a real probe, `null` means
 * we have not probed (so the honest answer for "payable" comes from attempting
 * a real quote, never from a cache miss). We never fabricate a route.
 */
export async function getTokenIntelligence(
  token: TokenConfig,
  opts: { network?: MonadNetwork; routable?: boolean | null; probeRoute?: boolean } = {},
): Promise<TokenIntelligence> {
  const network = opts.network ?? "mainnet";

  const price = await getPriceResolver()
    .resolve(token, network)
    .catch(() => null);

  let routable = opts.routable ?? null;
  if (routable === null && opts.probeRoute) {
    try {
      routable = await getRoutingProvider(network).isRoutable?.(token, network) ?? null;
    } catch {
      routable = null;
    }
  }

  const capabilities: TokenCapabilities = {
    exists: true,
    identified: token.symbol !== "Unknown",
    priced: Boolean(price?.usd && price.usd > 0),
    routable: routable === true,
    routeProbed: routable !== null,
  };

  const state = deriveTokenState(capabilities);
  return {
    state,
    flags: tokenStateFlags(capabilities),
    capabilities,
    payable: state === "PAYABLE",
    price: price
      ? { usd: price.usd, source: price.source, label: price.label, status: price.status }
      : null,
  };
}
