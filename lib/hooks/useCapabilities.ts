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
    rpc: "alchemy" | "public";
    alchemy: boolean;
    alchemyConfigured?: boolean;
    alchemyReachable?: boolean;
    alchemyError?: string;
    /** ERC-4337 Bundler reachability. */
    bundlerConfigured?: boolean;
    bundlerReachable?: boolean;
    bundlerError?: string;
    /** Gas Manager (paymaster) configuration + reachability. */
    paymasterConfigured?: boolean;
    paymasterReachable?: boolean;
    paymasterPolicyValid?: boolean;
    paymasterError?: string;
    policyStatus?: "active" | "expired" | "not_yet_active" | "unknown";
    policyReason?: string;
    sponsorshipConfigured: boolean;
    erc20GasConfigured: boolean;
    /** Addresses the configured paymaster sponsors (empty = unknown). */
    supportedTokens?: string[];
    policyId?: string;
  };
  /**
   * ERC-20 gas payment provider (lets a user with 0 MON pay gas in a held
   * token). Distinct from Alchemy sponsorship; `supportedTokens` is discovered
   * live and is empty when discovery failed.
   */
  gasPayment?: {
    provider: string | null;
    chainId: number;
    configured: boolean;
    reachable: boolean;
    available: boolean;
    error: string | null;
    supportedTokens: { address: string; symbol: string; name: string; decimals: number }[];
  };
  /** Whether a wallet-abstraction path is genuinely available. */
  walletAbstraction?: { available: boolean; reason: string | null };
  /**
   * True only for the degraded fallback returned when /api/capabilities could
   * not be reached. The provider configuration is then *unknown*, so the UI
   * must not assert "no paymaster is configured".
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
    rpc: "public",
    alchemy: false,
    alchemyConfigured: false,
    alchemyReachable: false,
    sponsorshipConfigured: false,
    erc20GasConfigured: false,
  },
  walletAbstraction: {
    available: false,
    reason: "Capabilities unavailable.",
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
