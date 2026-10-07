import type { Address } from "viem";
import { CURATED_TOKENS, type CuratedToken } from "@/lib/config/curated";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";

/**
 * Runtime token discovery source.
 *
 * The static `CURATED_TOKENS` array is only a *fallback*. At runtime we fetch
 * the official Monad token list so a token added upstream after this app was
 * deployed becomes searchable without a new frontend build. If the fetch fails
 * we degrade to the shipped snapshot rather than blocking the user.
 *
 * Only the *seed catalog* is remote. Whether a token is actually payable is
 * never decided here — that is the routing layer's job.
 */

const LIST_URL =
  process.env.MONAD_TOKEN_LIST_URL ??
  "https://raw.githubusercontent.com/monad-crypto/token-list/main/tokenlist-mainnet.json";

/** How long a fetched list is trusted before we revalidate it. */
const LIST_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export type CatalogSource = "remote" | "fallback";

export type TokenCatalog = {
  tokens: CuratedToken[];
  source: CatalogSource;
  /** Stable identifier for the active catalog; used to invalidate caches. */
  version: string;
  fetchedAt: number;
};

type RemoteEntry = {
  chainId?: number;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
};

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

/** Normalise + validate a remote list. Invalid entries are dropped, never guessed. */
export function parseRemoteTokenList(json: unknown, chainId: number): CuratedToken[] {
  const raw = (json as { tokens?: unknown })?.tokens;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CuratedToken[] = [];
  for (const item of raw as RemoteEntry[]) {
    if (!item || typeof item !== "object") continue;
    // A list for the wrong chain must never leak in.
    if (item.chainId !== undefined && item.chainId !== chainId) continue;
    if (!isAddress(item.address)) continue;
    if (typeof item.symbol !== "string" || !item.symbol.trim()) continue;
    if (typeof item.name !== "string" || !item.name.trim()) continue;
    if (!Number.isInteger(item.decimals) || (item.decimals as number) < 0 || (item.decimals as number) > 36) {
      continue;
    }
    const key = item.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      address: item.address as Address,
      symbol: item.symbol.trim(),
      name: item.name.trim(),
      decimals: item.decimals as number,
      logoURI: typeof item.logoURI === "string" ? item.logoURI : undefined,
    });
  }
  return out;
}

const fallbackCatalog: TokenCatalog = {
  tokens: CURATED_TOKENS,
  source: "fallback",
  version: "fallback",
  fetchedAt: 0,
};

const cache = new Map<MonadNetwork, TokenCatalog>();
const inflight = new Map<MonadNetwork, Promise<TokenCatalog>>();

function versionOf(source: CatalogSource, tokens: CuratedToken[]): string {
  // Cheap content hash so a changed list invalidates the routing graph.
  let h = 2166136261;
  const add = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  add(source);
  for (const t of tokens) add(`${t.address.toLowerCase()}:${t.symbol}:${t.decimals}`);
  return (h >>> 0).toString(36);
}

async function fetchCatalog(network: MonadNetwork): Promise<TokenCatalog> {
  const chainId = NETWORKS[network].chainId;
  // Only mainnet has an upstream list today.
  if (network !== "mainnet") return fallbackCatalog;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LIST_URL, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return fallbackCatalog;
    const json = await res.json();
    const tokens = parseRemoteTokenList(json, chainId);
    if (tokens.length === 0) return fallbackCatalog;
    return { tokens, source: "remote", version: versionOf("remote", tokens), fetchedAt: Date.now() };
  } catch {
    return fallbackCatalog;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The active token catalog for a network. Fetched at most once per TTL, with
 * concurrent callers sharing a single in-flight request.
 */
export async function getCatalog(network: MonadNetwork = "mainnet"): Promise<TokenCatalog> {
  const cached = cache.get(network);
  if (cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) return cached;

  const existing = inflight.get(network);
  if (existing) return existing;

  const p = fetchCatalog(network)
    .then((catalog) => {
      // Keep serving a previously-good remote list if a refresh fails.
      const value = catalog.source === "fallback" && cached ? cached : catalog;
      cache.set(network, value);
      return value;
    })
    .finally(() => inflight.delete(network));
  inflight.set(network, p);
  return p;
}

/** The shipped snapshot, used before any fetch and as the offline fallback. */
export function fallbackTokens(): CuratedToken[] {
  return CURATED_TOKENS;
}
