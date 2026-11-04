"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";
import { monadAddChainParams } from "@/lib/wallet/monadChain";
import type { Balance } from "@/lib/domain/intent";
import { classifyWalletError, type WalletErrorInfo } from "@/lib/domain/walletError";
import {
  watchWallets,
  type DiscoveredWallet,
  type Eip1193Provider,
} from "@/lib/wallet/eip6963";
import {
  chainIdFromHex,
  connectionErrorMessage,
  firstAccount,
  pickRestorableWallet,
} from "@/lib/wallet/connection";
import {
  getWalletConnectProvider,
  resetWalletConnect,
  walletConnectConfigured,
} from "@/lib/wallet/walletconnect";

export type { Eip1193Provider } from "@/lib/wallet/eip6963";

export type WalletStatus = "disconnected" | "connecting" | "connected";

/**
 * One selectable way to connect. Injected wallets are discovered via EIP-6963
 * (with a legacy `window.ethereum` fallback); WalletConnect is offered only
 * when a project id is configured.
 */
export type WalletOption = {
  id: string;
  name: string;
  icon: string;
  kind: "injected" | "walletconnect";
  /** True when the option can actually be used right now (e.g. WC configured). */
  available: boolean;
  /** An honest reason the option is unavailable, when it is. */
  reason?: string;
};

export type WalletState = {
  status: WalletStatus;
  address?: Address;
  chainId?: number;
  network: MonadNetwork;
  error?: string;
  hasProvider: boolean;
  /** The id of the wallet currently connected/selected, when known. */
  connectorId?: string;
  /** How the current connection was made. */
  kind?: "injected" | "walletconnect";
  /** True while a restored page load is checking for an existing session. */
  restoring: boolean;
};

const INITIAL: WalletState = {
  status: "disconnected",
  network: "mainnet",
  hasProvider: false,
  restoring: true,
};

/** localStorage key remembering the wallet the user chose. */
const STORAGE_KEY = "intentpay.wallet.connector";

function readStoredConnector(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredConnector(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); selection is then not restored.
  }
}

/** The reserved id for the WalletConnect connector. */
export const WALLETCONNECT_ID = "walletconnect";

type WalletContextValue = WalletState & {
  /** Every wallet the user can connect with right now. */
  wallets: WalletOption[];
  connect: (walletId?: string) => Promise<void>;
  disconnect: () => void;
  ensureMonad: () => Promise<{ ok: true } | { ok: false; error: WalletErrorInfo }>;
  walletClient?: WalletClient;
  provider?: Eip1193Provider;
  /** Rescan injected wallets (e.g. after a user installs one). */
  refresh: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * The single owner of wallet connectivity for the app.
 *
 * One provider instance is shared by the header, the composer and the referral
 * panel, so a wallet is connected exactly once and every consumer sees the same
 * account, chain and client. Two independent `useWallet` instances (as before)
 * meant two sets of listeners and two chances to disagree.
 *
 * The provider supports several injected wallets at once (EIP-6963), a legacy
 * `window.ethereum`, and an optional WalletConnect session — all reduced to the
 * same EIP-1193 surface, so the payment pipeline is identical for each.
 */
export function WalletProvider({
  children,
  network = "mainnet",
}: {
  children: React.ReactNode;
  network?: MonadNetwork;
}) {
  const [state, setState] = useState<WalletState>({ ...INITIAL, network });
  const [injected, setInjected] = useState<DiscoveredWallet[]>([]);
  const [wcReady, setWcReady] = useState(false);

  // The active provider (injected or WalletConnect) and its identity.
  const providerRef = useRef<Eip1193Provider | undefined>(undefined);
  const kindRef = useRef<"injected" | "walletconnect" | undefined>(undefined);
  // Detach the previous provider's listeners without touching the new one.
  const detachRef = useRef<(() => void) | undefined>(undefined);
  // The injected wallets seen by the restore effect without re-triggering it.
  const injectedRef = useRef<DiscoveredWallet[]>([]);
  injectedRef.current = injected;

  // ---- Discovery -----------------------------------------------------------
  const [discoveryNonce, setDiscoveryNonce] = useState(0);
  useEffect(() => {
    const { destroy } = watchWallets(window, setInjected);
    return destroy;
    // Re-scan when the caller asks (a wallet may have been installed mid-session).
  }, [discoveryNonce]);

  const refresh = useCallback(() => setDiscoveryNonce((n) => n + 1), []);

  // ---- The selectable options ---------------------------------------------
  const wallets = useMemo<WalletOption[]>(() => {
    const injectedOptions: WalletOption[] = injected.map((w) => ({
      id: w.id,
      name: w.name,
      icon: w.icon,
      kind: "injected" as const,
      available: true,
    }));
    const wcOption: WalletOption = {
      id: WALLETCONNECT_ID,
      name: "WalletConnect",
      icon: "",
      kind: "walletconnect",
      available: wcReady,
      reason: wcReady
        ? undefined
        : "WalletConnect needs a project id. Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable mobile and QR wallets.",
    };
    return [...injectedOptions, wcOption];
  }, [injected, wcReady]);

  // Resolve the WalletConnect option's availability once, client-side.
  useEffect(() => {
    setWcReady(walletConnectConfigured());
  }, []);

  const hasProvider = injected.length > 0 || wcReady;

  // ---- Provider event wiring ----------------------------------------------
  const attach = useCallback(
    (provider: Eip1193Provider, kind: "injected" | "walletconnect", id: string) => {
      detachRef.current?.();
      providerRef.current = provider;
      kindRef.current = kind;

      const onAccounts = (accounts: string[]) => {
        const address = firstAccount(accounts);
        setState((s) => ({
          ...s,
          address,
          status: address ? "connected" : "disconnected",
          // An empty list from the *active* provider is a real disconnect.
          connectorId: address ? id : undefined,
        }));
      };
      const onChain = (chainIdHex: string) => {
        const chainId = chainIdFromHex(chainIdHex);
        if (chainId === undefined) return;
        setState((s) => ({ ...s, chainId }));
      };
      const onDisconnect = () => {
        setState((s) => ({
          ...s,
          status: "disconnected",
          address: undefined,
          chainId: undefined,
          connectorId: undefined,
        }));
      };
      provider.on?.("accountsChanged", onAccounts);
      provider.on?.("chainChanged", onChain);
      provider.on?.("disconnect", onDisconnect);
      detachRef.current = () => {
        provider.removeListener?.("accountsChanged", onAccounts);
        provider.removeListener?.("chainChanged", onChain);
        provider.removeListener?.("disconnect", onDisconnect);
      };
    },
    [],
  );

  // ---- Silent reconnect for the previously chosen wallet -------------------
  // Runs once, after a short delay so late EIP-6963 announcements are included.
  const restoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const storedId = readStoredConnector();

      // WalletConnect: restore a live session by re-initialising the provider
      // (the SDK persists the session in local storage) and checking for an
      // authorised account. No account means the session expired — we stay
      // disconnected rather than showing a phantom one.
      if (storedId === WALLETCONNECT_ID && walletConnectConfigured()) {
        const provider = await getWalletConnectProvider();
        if (cancelled || !provider) {
          if (!cancelled) setState((s) => ({ ...s, restoring: false }));
          return;
        }
        attach(provider, "walletconnect", WALLETCONNECT_ID);
        try {
          const accounts = await provider.request({ method: "eth_accounts" });
          if (cancelled) return;
          const address = firstAccount(accounts);
          const chainIdHex = address
            ? ((await provider.request({ method: "eth_chainId" })) as string)
            : undefined;
          setState((s) => ({
            ...s,
            restoring: false,
            address,
            chainId: chainIdFromHex(chainIdHex),
            status: address ? "connected" : "disconnected",
            connectorId: address ? WALLETCONNECT_ID : undefined,
            kind: address ? "walletconnect" : undefined,
          }));
        } catch {
          if (!cancelled) setState((s) => ({ ...s, restoring: false }));
        }
        return;
      }

      const restorableId = pickRestorableWallet(storedId, injectedRef.current);
      const wallet = restorableId
        ? injectedRef.current.find((w) => w.id === restorableId)
        : undefined;
      if (!wallet) {
        if (!cancelled) setState((s) => ({ ...s, restoring: false }));
        return;
      }
      attach(wallet.provider, "injected", wallet.id);
      try {
        const accounts = await wallet.provider.request({ method: "eth_accounts" });
        if (cancelled) return;
        const address = firstAccount(accounts);
        const chainIdHex = address
          ? ((await wallet.provider.request({ method: "eth_chainId" })) as string)
          : undefined;
        setState((s) => ({
          ...s,
          restoring: false,
          address,
          chainId: chainIdFromHex(chainIdHex),
          status: address ? "connected" : "disconnected",
          connectorId: address ? wallet.id : undefined,
          kind: address ? "injected" : undefined,
        }));
      } catch {
        if (!cancelled) setState((s) => ({ ...s, restoring: false }));
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attach]);

  // Keep `hasProvider` in sync with discovery even when nothing is restored.
  useEffect(() => {
    setState((s) => (s.hasProvider === hasProvider ? s : { ...s, hasProvider }));
  }, [hasProvider]);

  // ---- Connect -------------------------------------------------------------
  const connect = useCallback(
    async (walletId?: string) => {
      setState((s) => ({ ...s, status: "connecting", error: undefined }));

      // Which wallet to use: the explicit choice, the stored choice, or the
      // first injected wallet as a sensible default.
      const targetId =
        walletId ?? pickRestorableWallet(readStoredConnector(), injected) ?? injected[0]?.id;

      try {
        if (targetId === WALLETCONNECT_ID) {
          const provider = await getWalletConnectProvider();
          if (!provider) {
            setState((s) => ({
              ...s,
              status: "disconnected",
              error: "WalletConnect is not configured on this deployment.",
            }));
            return;
          }
          attach(provider, "walletconnect", WALLETCONNECT_ID);
          await provider.request({ method: "eth_requestAccounts" });
          const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
          const address = firstAccount(await provider.request({ method: "eth_accounts" }));
          writeStoredConnector(WALLETCONNECT_ID);
          setState((s) => ({
            ...s,
            status: address ? "connected" : "disconnected",
            address,
            chainId: chainIdFromHex(chainIdHex),
            connectorId: WALLETCONNECT_ID,
            kind: "walletconnect",
            restoring: false,
            error: undefined,
          }));
          return;
        }

        const wallet = injected.find((w) => w.id === targetId) ?? injected[0];
        if (!wallet) {
          setState((s) => ({
            ...s,
            status: "disconnected",
            error:
              "No browser wallet detected. Install a wallet such as MetaMask, or use WalletConnect.",
          }));
          return;
        }
        attach(wallet.provider, "injected", wallet.id);
        const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
        const chainIdHex = (await wallet.provider.request({ method: "eth_chainId" })) as string;
        const address = firstAccount(accounts);
        writeStoredConnector(wallet.id);
        setState((s) => ({
          ...s,
          status: address ? "connected" : "disconnected",
          address,
          chainId: chainIdFromHex(chainIdHex),
          connectorId: wallet.id,
          kind: "injected",
          restoring: false,
          error: undefined,
        }));
      } catch (err) {
        setState((s) => ({
          ...s,
          status: "disconnected",
          error: connectionErrorMessage(err),
        }));
      }
    },
    [injected, attach],
  );

  // ---- Disconnect ----------------------------------------------------------
  const disconnect = useCallback(() => {
    const kind = kindRef.current;
    detachRef.current?.();
    detachRef.current = undefined;
    providerRef.current = undefined;
    kindRef.current = undefined;
    writeStoredConnector(null);
    if (kind === "walletconnect") void resetWalletConnect();
    setState((s) => ({
      ...s,
      status: "disconnected",
      address: undefined,
      chainId: undefined,
      connectorId: undefined,
      kind: undefined,
      error: undefined,
    }));
  }, []);

  // ---- Chain switch --------------------------------------------------------
  const ensureMonad = useCallback(async (): Promise<
    { ok: true } | { ok: false; error: WalletErrorInfo }
  > => {
    const provider = providerRef.current;
    if (!provider) {
      return {
        ok: false,
        error: {
          kind: "unknown",
          rejected: false,
          message: "No wallet connected. Connect a wallet to pay on Monad.",
        },
      };
    }
    const target = NETWORKS[network].chainId;
    try {
      const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
      if (chainIdFromHex(chainIdHex) === target) return { ok: true };
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + target.toString(16) }],
      });
      setState((s) => ({ ...s, chainId: target }));
      return { ok: true };
    } catch (err: any) {
      if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message ?? "")) {
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [monadAddChainParams(network)],
          });
          setState((s) => ({ ...s, chainId: target }));
          return { ok: true };
        } catch (addErr) {
          return { ok: false, error: classifyWalletError(addErr) };
        }
      }
      return { ok: false, error: classifyWalletError(err) };
    }
  }, [network]);

  // ---- Derived viem client -------------------------------------------------
  const walletClient = useMemo<WalletClient | undefined>(() => {
    const provider = providerRef.current;
    if (!provider || !state.address) return undefined;
    return createWalletClient({
      account: state.address,
      chain: NETWORKS[network].chain,
      transport: custom(provider as any),
    });
  }, [state.address, network, state.connectorId]);

  const value = useMemo<WalletContextValue>(
    () => ({
      ...state,
      network,
      wallets,
      connect,
      disconnect,
      ensureMonad,
      walletClient,
      provider: providerRef.current,
      refresh,
    }),
    [state, network, wallets, connect, disconnect, ensureMonad, walletClient, refresh],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/**
 * Access the shared wallet connection. Must be used within `WalletProvider`.
 * The returned shape is a superset of the historical `useWallet` hook, so
 * existing consumers (the composer, the header, the referral panel) keep
 * working unchanged.
 */
export function useWallet(_network?: MonadNetwork): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
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
