import { NATIVE_ADDRESS } from "./chains";
import { CURATED_TOKENS, type CuratedToken } from "./curated";
import { WMON_ADDRESS } from "@/lib/providers/constants";

/**
 * A payment asset. All token metadata is data — the UI never branches on a
 * specific symbol, so adding or discovering a token is never a code change.
 *
 * `source` records *why we believe this token exists*:
 *  - "native"  — the chain's gas asset (MON)
 *  - "seed"    — shipped as a known-good default
 *  - "list"    — discovered from the official Monad token list
 *  - "onchain" — metadata read directly from a contract the user supplied
 *  - "wallet"  — found by scanning the connected wallet's assets
 */
export type TokenSource = "native" | "seed" | "list" | "onchain" | "wallet";

export type TokenConfig = {
  symbol: string;
  name: string;
  /** Monad mainnet contract address (native sentinel for MON). */
  address: `0x${string}`;
  decimals: number;
  /** Native asset (MON) — no contract, paid as msg.value. */
  native?: boolean;
  /** Known fallback USD price, used only in demo / when no live price exists. */
  fallbackUsd: number;
  /** Glyph tint for the token badge. */
  tint: string;
  /** Where this token's metadata came from. */
  source?: TokenSource;
  /** Logo URL when a trusted list provides one. */
  logoURI?: string;
  /** True only for the small shipped seed set (used for display ordering). */
  seed?: boolean;
};

/**
 * Shipped defaults. These are *examples of currently supported assets*, not the
 * source of truth — the app discovers the rest at runtime. Kept small and
 * verified so the first paint and Demo Mode never depend on a network fetch.
 */
export const SEED_TOKENS: TokenConfig[] = [
  {
    symbol: "MON",
    name: "Monad",
    address: NATIVE_ADDRESS,
    decimals: 18,
    native: true,
    fallbackUsd: 0.029,
    tint: "#836EF9",
    source: "native",
    seed: true,
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    decimals: 6,
    fallbackUsd: 1,
    tint: "#2775CA",
    source: "seed",
    seed: true,
  },
  {
    symbol: "USDT",
    name: "Tether USD (USDT0)",
    address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    decimals: 6,
    fallbackUsd: 1,
    tint: "#26A17B",
    source: "seed",
    seed: true,
  },
  {
    symbol: "SOL",
    name: "Wrapped SOL",
    address: "0xea17E5a9efEBf1477dB45082d67010E2245217f1",
    decimals: 9,
    fallbackUsd: 180,
    tint: "#14F195",
    source: "seed",
    seed: true,
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
    decimals: 18,
    fallbackUsd: 3200,
    tint: "#8A92B2",
    source: "seed",
    seed: true,
  },
  {
    symbol: "AUSD",
    name: "Agora USD",
    address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    decimals: 6,
    fallbackUsd: 1,
    tint: "#4F8DF7",
    source: "seed",
    seed: true,
  },
];

/** Deterministic accent colour so discovered tokens still look intentional. */
export function tintForAddress(address: string): string {
  const palette = [
    "#836EF9",
    "#4F8DF7",
    "#26A17B",
    "#F0A93B",
    "#E4577A",
    "#3FB8C4",
    "#8A92B2",
    "#B98BF5",
    "#5BC98A",
    "#E0704A",
  ];
  let h = 0;
  const a = (address ?? "").toLowerCase();
  for (let i = 2; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// ---------------------------------------------------------------------------
// Runtime registry
//
// Seed tokens are always present. Everything else is registered as it is
// discovered (from the official list, from a pasted address, or from a wallet
// scan). Nothing here is a permanent allow-list: a token launched after deploy
// becomes usable the moment it is discovered and has a route.
// ---------------------------------------------------------------------------

const registry = new Map<string, TokenConfig>();

function key(address: string): string {
  return (address ?? "").toLowerCase();
}

function rank(source: TokenSource | undefined): number {
  switch (source) {
    case "native":
      return 5;
    case "seed":
      return 4;
    case "list":
      return 3;
    case "onchain":
      return 2;
    case "wallet":
      return 1;
    default:
      return 0;
  }
}

function put(token: TokenConfig) {
  const existing = registry.get(key(token.address));
  // Never let a later, less-trusted source downgrade a known-good record.
  if (existing && rank(existing.source) > rank(token.source)) return;
  registry.set(key(token.address), token);
}

for (const t of SEED_TOKENS) put(t);

/** Register a dynamically discovered token. Returns the stored record. */
export function registerToken(token: TokenConfig): TokenConfig {
  put(token);
  return registry.get(key(token.address))!;
}

export function getToken(symbol: string): TokenConfig | undefined {
  const needle = (symbol ?? "").toLowerCase();
  for (const t of registry.values()) if (t.symbol.toLowerCase() === needle) return t;
  return undefined;
}

export function getTokenByAddress(address: string): TokenConfig | undefined {
  return registry.get(key(address));
}

export function tokenBySymbol(symbol: string): TokenConfig {
  const t = getToken(symbol);
  if (!t) throw new Error(`Unknown token: ${symbol}`);
  return t;
}

/**
 * The address used by Uniswap pools for a token. The native asset has no
 * contract, so it is pooled in its wrapped form (WMON). Lives here so the
 * config layer can compare tokens the way the router does.
 */
export function poolAddressOf(token: TokenConfig): string {
  return (token.native ? WMON_ADDRESS : token.address).toLowerCase();
}

/**
 * Tokens treated as $1 USD anchors when pricing other tokens. This is a *peg
 * assumption* (never used to fabricate a swap rate), kept here as
 * configuration rather than inside the routing layer. Extending it is a config
 * change, not a code change; a token not listed is still priced on chain via
 * the quoter, so a newly listed stablecoin is never mispriced as free.
 */
export const USD_ANCHOR_SYMBOLS = new Set(["USDC", "USDT", "AUSD"]);

export function isUsdAnchor(token: TokenConfig): boolean {
  return USD_ANCHOR_SYMBOLS.has(token.symbol);
}

/** Everything currently known, seeds first, then alphabetical. */
export function allTokens(): TokenConfig[] {
  return [...registry.values()].sort((a, b) => {
    if (a.seed !== b.seed) return a.seed ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** Tokens the recipient can receive — anything we can transfer or route to. */
export function receivableTokens(): TokenConfig[] {
  return allTokens();
}

/** Tokens the sender can pay with — anything the wallet holds or can wrap. */
export function payableTokens(): TokenConfig[] {
  return allTokens();
}

// ---------------------------------------------------------------------------
// Curated catalog (a discovery seed for search, not a hard allow-list)
//
// The *active* catalog is set at runtime from the discovery source (the official
// Monad list, fetched live). The static CURATED_TOKENS array is only the
// fallback used before a fetch succeeds / when offline. This is what lets a
// token added upstream after deployment become searchable without a rebuild.
// ---------------------------------------------------------------------------

let activeCatalog: CuratedToken[] | null = null;
let activeVersion = "static";

/** Install the runtime catalog (from the discovery source). */
export function setActiveCatalog(tokens: CuratedToken[], version: string): void {
  activeCatalog = tokens;
  activeVersion = version;
  // Register every entry so symbol/address lookups resolve app-wide without a
  // separate resolve step. Rank-safe: never downgrades a seed record.
  for (const t of tokens) configFromCurated(t);
}

/** Bumped whenever the active catalog changes, so caches can invalidate. */
export function catalogVersion(): string {
  return activeVersion;
}

/** Drop back to the shipped snapshot (used when discovery is unavailable). */
export function resetCatalog(): void {
  activeCatalog = null;
  activeVersion = "static";
}

/** The official Monad token list entries (active catalog, plus our seeds). */
export function curatedCatalog(): CuratedToken[] {
  const seen = new Set<string>();
  const out: CuratedToken[] = [];
  for (const t of SEED_TOKENS) {
    if (t.native) continue;
    const k = key(t.address);
    seen.add(k);
    out.push({
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoURI: t.logoURI,
    });
  }
  for (const t of activeCatalog ?? CURATED_TOKENS) {
    const k = key(t.address);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Turn a curated entry into a full TokenConfig and register it. */
export function configFromCurated(entry: CuratedToken, source: TokenSource = "list"): TokenConfig {
  return registerToken({
    symbol: entry.symbol,
    name: entry.name,
    address: entry.address,
    decimals: entry.decimals,
    fallbackUsd: 0,
    tint: tintForAddress(entry.address),
    source,
    logoURI: entry.logoURI,
  });
}

export type { CuratedToken };
