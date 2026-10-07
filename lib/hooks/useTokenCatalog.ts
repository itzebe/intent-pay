"use client";

import { useEffect, useState } from "react";
import { SEED_TOKENS, registerToken, type TokenConfig } from "@/lib/config/tokens";
import type { AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * `routable` is tri-state on purpose:
 *   true  — probed and has a liquid route
 *   false — probed and has no liquid route
 *   null  — not probed yet; the honest answer comes from a real quote
 */
export type CatalogToken = TokenConfig & {
  routable?: boolean | null;
  listed?: boolean;
};

export type CatalogInfo = {
  count: number;
  source: "remote" | "fallback" | string;
  version: string;
};

/**
 * Loads the token catalog from the discovery API and registers every entry in
 * the runtime registry. The catalog is fetched live from the official Monad
 * list, so a token added upstream after deployment appears here with no code
 * change. Works in both modes: discovery is a data concern, not a live-quote
 * concern.
 */
export function useTokenCatalog(mode: AppMode, network: MonadNetwork) {
  const [tokens, setTokens] = useState<CatalogToken[]>(SEED_TOKENS as CatalogToken[]);
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/tokens?mode=${mode}&network=${network}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json?.ok) return;
        const list = (json.tokens as CatalogToken[]) ?? [];
        for (const t of list) registerToken(t);
        setTokens(list.length ? list : (SEED_TOKENS as CatalogToken[]));
        setInfo(json.catalog ?? null);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the token catalog.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, network]);

  return { tokens, info, loading, error };
}

export type ResolvedPrice = {
  usd: number | null;
  source: "stable" | "market" | "dex" | "onchain" | "fallback" | "unavailable";
  label: string;
};

export type ResolvedTokenResponse = {
  ok: boolean;
  found?: boolean;
  listed?: boolean;
  /** true = payable, false = no route, null/undefined = unknown (unprobed). */
  routable?: boolean | null;
  /** Live price resolution — independent of routability. */
  price?: ResolvedPrice | null;
  problem?: string;
  code?: string;
  message?: string;
  token?: CatalogToken;
};

/** Resolve a pasted address against the chain (metadata + routability). */
export async function resolveAddress(
  address: string,
  mode: AppMode,
  network: MonadNetwork,
): Promise<ResolvedTokenResponse> {
  const res = await fetch("/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, mode, network }),
  });
  return res.json();
}

/** Server-side search (symbol / name / address) for tokens beyond the cache. */
export async function searchCatalog(
  query: string,
  mode: AppMode,
  network: MonadNetwork,
): Promise<CatalogToken[]> {
  const res = await fetch(
    `/api/tokens?q=${encodeURIComponent(query)}&mode=${mode}&network=${network}`,
    { cache: "no-store" },
  );
  const json = await res.json();
  return (json?.results as CatalogToken[]) ?? [];
}
