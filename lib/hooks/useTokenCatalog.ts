"use client";

import { useEffect, useState } from "react";
import { SEED_TOKENS, registerToken, type TokenConfig } from "@/lib/config/tokens";
import type { AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";

export type CatalogToken = TokenConfig & {
  /** Whether a liquid route currently exists (live mode only). */
  routable?: boolean;
  listed?: boolean;
};

/**
 * Loads the token catalog from the discovery API and registers every entry in
 * the runtime registry. This is what lets a token that is not a shipped seed —
 * e.g. one added to the official Monad list after deployment — appear in the UI
 * with no code change.
 */
export function useTokenCatalog(mode: AppMode, network: MonadNetwork) {
  const [tokens, setTokens] = useState<CatalogToken[]>(SEED_TOKENS as CatalogToken[]);
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

  return { tokens, loading, error };
}

export type ResolvedTokenResponse = {
  ok: boolean;
  found?: boolean;
  listed?: boolean;
  routable?: boolean;
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
