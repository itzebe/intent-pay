"use client";

import { useEffect, useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * What infrastructure is configured (routing, pricing, wallet intelligence).
 * Fetched once per network; the UI uses it to label providers honestly.
 *
 * Gas is always paid in MON, so there is no sponsorship / account-abstraction
 * capability to report.
 */
export type Capabilities = {
  routing: { provider: string; chain: string; live: boolean };
  pricing: { primary: string | null; fallbacks: string[] };
  /** Honest MEV / private-order-flow capability (never a cosmetic badge). */
  mevProtection?: {
    state: "MEV_PROTECTION_ACTIVE" | "MEV_PROTECTION_UNAVAILABLE";
    active: boolean;
    privateRpcConfigured: boolean;
    reason: string;
  };
  wallet: {
    zerion: boolean;
    zerionConfigured?: boolean;
    zerionReachable?: boolean;
    zerionError?: string;
  };
  gas: {
    /** The network fee is always paid in the native asset (MON). */
    mode: "native";
    rpc: "alchemy" | "public";
    /** Alchemy is configured (may still be unreachable). */
    alchemy: boolean;
    alchemyConfigured: boolean;
    alchemyReachable: boolean;
    alchemyError?: string;
  };
  /**
   * True only for the degraded fallback returned when /api/capabilities could
   * not be reached. Provider configuration is then *unknown*, so the UI must not
   * assert any provider is absent.
   */
  unavailable?: boolean;
};

const FALLBACK: Capabilities = {
  unavailable: true,
  routing: { provider: "uniswap-v3", chain: "monad", live: true },
  pricing: { primary: null, fallbacks: [] },
  mevProtection: {
    state: "MEV_PROTECTION_UNAVAILABLE",
    active: false,
    privateRpcConfigured: false,
    reason: "Capabilities unavailable.",
  },
  wallet: { zerion: false, zerionConfigured: false, zerionReachable: false },
  gas: {
    mode: "native",
    rpc: "public",
    alchemy: false,
    alchemyConfigured: false,
    alchemyReachable: false,
  },
};

export function useCapabilities(network: MonadNetwork) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/capabilities?network=${network}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setCapabilities(json?.ok ? (json as Capabilities) : FALLBACK);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(FALLBACK);
      });
    return () => {
      cancelled = true;
    };
  }, [network]);

  return capabilities;
}
