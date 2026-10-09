"use client";

import { useEffect, useMemo, useState } from "react";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * Live, per-wallet ERC-20 gas capability.
 *
 * Unlike `/api/capabilities` (which describes the deployment), this is scoped to
 * the connected account: it intersects the paymaster's supported tokens with the
 * wallet's actual balances and a live fee quote, so the UI can show exactly
 * which token will pay gas — or the precise reason none can.
 *
 * The wallet's own compatibility (can it sign an EIP-7702 UserOperation?) is
 * passed in and combined client-side, because only the browser can probe it.
 */
export type GasTokenView = {
  chainId: number;
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  held: boolean;
  balance: string;
  sufficientBalance: boolean;
  quoteKnown: boolean;
  estimatedFee: string | null;
  estimatedFeeUsd: string | null;
  selected: boolean;
};

export type AaCapability = {
  ok: boolean;
  chainId: number;
  provider: { id: string | null; configured: boolean; reachable: boolean; error: string | null };
  walletAbstraction: {
    available: boolean;
    mode: "ERC20_PAYMASTER" | "NATIVE" | "UNAVAILABLE";
    provider: string | null;
    chainId: number;
    account: `0x${string}` | null;
    supportedGasTokens: GasTokenView[];
    selectedGasToken: GasTokenView | null;
    code: string;
    reason: string | null;
    walletCompatible: boolean;
  };
  supportedGasTokens: GasTokenView[];
  selection: {
    code: string;
    reason: string;
    nativeRequired: boolean;
    explicitIssue: string | null;
    selected: { address: string; symbol: string; decimals: number } | null;
  };
};

export function useAaCapability(
  network: MonadNetwork,
  owner: string | undefined,
  opts: {
    explicitGasToken?: string | null;
    sourceSymbol?: string | null;
    gasUnits?: string | null;
    /** Whether the wallet can sign an AA UserOperation (from the wallet probe). */
    walletCompatible?: boolean;
    /** Refresh key — bump to force a re-fetch after a balance change. */
    tick?: number;
  } = {},
) {
  const [capability, setCapability] = useState<AaCapability | null>(null);
  const [loading, setLoading] = useState(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (owner) p.set("owner", owner);
    if (opts.explicitGasToken) p.set("gasToken", opts.explicitGasToken);
    if (opts.sourceSymbol) p.set("source", opts.sourceSymbol);
    if (opts.gasUnits) p.set("gasUnits", opts.gasUnits);
    if (opts.walletCompatible === false) p.set("walletCompatible", "0");
    p.set("chainId", "143");
    return p.toString();
  }, [owner, opts.explicitGasToken, opts.sourceSymbol, opts.gasUnits, opts.walletCompatible]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/aa/capability?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setCapability(json?.ok ? (json as AaCapability) : null);
      })
      .catch(() => {
        if (!cancelled) setCapability(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [qs, opts.tick, network]);

  return { capability, loading };
}
