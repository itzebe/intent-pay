"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";
import { monadAddChainParams } from "@/lib/wallet/monadChain";
import type { Balance } from "@/lib/domain/intent";

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export type WalletState = {
  status: "disconnected" | "connecting" | "connected";
  address?: Address;
  chainId?: number;
  network: MonadNetwork;
  error?: string;
  hasProvider: boolean;
};

const INITIAL: WalletState = {
  status: "disconnected",
  network: "mainnet",
  hasProvider: false,
};

/** Pick the best injected provider (prefers MetaMask when several exist). */
function pickProvider(): Eip1193Provider | undefined {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  if (!eth) return undefined;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p.isMetaMask) ?? eth.providers[0];
  }
  return eth;
}

export function useWallet(network: MonadNetwork = "mainnet") {
  const [state, setState] = useState<WalletState>({ ...INITIAL, network });
  const providerRef = useRef<Eip1193Provider | undefined>(undefined);

  useEffect(() => {
    const provider = pickProvider();
    providerRef.current = provider;
    setState((s) => ({ ...s, hasProvider: Boolean(provider), network }));

    if (!provider) return;
    const onAccounts = (accounts: string[]) => {
      const address = (accounts?.[0] as Address) ?? undefined;
      setState((s) => ({
        ...s,
        address,
        status: address ? "connected" : "disconnected",
      }));
    };
    const onChain = (chainIdHex: string) => {
      setState((s) => ({ ...s, chainId: parseInt(chainIdHex, 16) }));
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);

    // Silent reconnect for wallets that are already authorised.
    provider
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        const list = accounts as string[];
        if (list?.length) {
          onAccounts(list);
        }
      })
      .catch(() => {});

    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [network]);

  const connect = useCallback(async () => {
    const provider = providerRef.current ?? pickProvider();
    if (!provider) {
      setState((s) => ({
        ...s,
        error: "No browser wallet detected. Install a browser wallet such as MetaMask to pay on Monad.",
      }));
      return;
    }
    providerRef.current = provider;
    setState((s) => ({ ...s, status: "connecting", error: undefined }));
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
      setState((s) => ({
        ...s,
        status: "connected",
        address: accounts[0] as Address,
        chainId: parseInt(chainIdHex, 16),
        error: undefined,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: "disconnected",
        error: (err as Error)?.message ?? "Connection rejected.",
      }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState((s) => ({ ...s, status: "disconnected", address: undefined }));
  }, []);

  const ensureMonad = useCallback(async () => {
    const provider = providerRef.current ?? pickProvider();
    if (!provider) return false;
    const target = NETWORKS[network].chainId;
    try {
      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
      if (parseInt(chainIdHex, 16) === target) return true;
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + target.toString(16) }],
      });
      return true;
    } catch (err: any) {
      if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message ?? "")) {
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [monadAddChainParams(network)],
          });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }, [network]);

  const walletClient = useMemo<WalletClient | undefined>(() => {
    const provider = providerRef.current;
    if (!provider || !state.address) return undefined;
    return createWalletClient({
      account: state.address,
      chain: NETWORKS[network].chain,
      transport: custom(provider as any),
    });
  }, [state.address, network]);

  return {
    ...state,
    connect,
    disconnect,
    ensureMonad,
    walletClient,
    provider: providerRef.current,
  };
}

/** Fetch balances for a connected (or demo) address from our API. */
export function useBalances(
  address: string | undefined,
  network: MonadNetwork,
  enabled = true,
) {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    if (!address || !enabled) return;
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch(
        `/api/balances?address=${address}&network=${network}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json?.message ?? "Failed to read balances");
      setBalances(json.balances as Balance[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address, network, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { balances, loading, error, refresh, setBalances };
}
