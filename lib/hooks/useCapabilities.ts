"use client";

import { useEffect, useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * What infrastructure is configured (routing, pricing, wallet intelligence,
 * gas). Fetched once per network; the UI uses it to label providers honestly
 * and to decide whether to offer sponsored / ERC-20 gas.
 */
export type Capabilities = {
  routing: { provider: string; chain: string; live: boolean };
  pricing: { primary: string | null; fallbacks: string[] };
  wallet: { zerion: boolean };
  gas: {
    rpc: "alchemy" | "public";
    alchemy: boolean;
    sponsorshipConfigured: boolean;
    erc20GasConfigured: boolean;
    policyId?: string;
  };
};

const FALLBACK: Capabilities = {
  routing: { provider: "uniswap-v3", chain: "monad", live: true },
  pricing: { primary: null, fallbacks: [] },
  wallet: { zerion: false },
  gas: { rpc: "public", alchemy: false, sponsorshipConfigured: false, erc20GasConfigured: false },
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
