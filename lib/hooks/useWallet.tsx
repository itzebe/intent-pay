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
 * Read a provider's current chain id, or `undefined` when the read fails.
 *
 * A page-world injected provider answers `eth_chainId` by proxying to the
 * wallet's own node, so the read can fail for reasons that have nothing to do
 * with whether the wallet is connected (a CSP-blocked RPC, an offline device).
 * Failing the whole connection on that would leave a genuinely authorised
 * wallet unable to connect, so the read is best-effort: an unreadable chain is
 * reported as *unknown* (undefined) — never silently coerced to Monad, which
 * would be a false "you're on Monad" claim.
 */
async function safeChainId(provider: Eip1193Provider): Promise<number | undefined> {
  try {
    return chainIdFromHex(await provider.request({ method: "eth_chainId" }));
  } catch {
    return undefined;
  }
}

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
  // Runs once, shortly after load so late EIP-6963 announcements are included,
  // and again if a stored injected wallet only appears later — the Trust Wallet
  // mobile case, where the stored connector exists but `window.ethereum` did not
  // exist when the first attempt ran.
  const restoreAttemptedRef = useRef(false);
  const restoredRef = useRef(false);
  /**
   * True only when the first attempt found a stored injected connector id but
   * the wallet itself was not present yet (a late injection). The late-restore
   * effect keys off this, so it can never resurrect a wallet the user has
   * deliberately disconnected or re-connected by hand.
   */
  const lateRestorePendingRef = useRef(false);

  const restore = useCallback(
    async (signal: { cancelled: boolean }) => {
      const cancelled = () => signal.cancelled;
      const storedId = readStoredConnector();

      // WalletConnect: restore a live session by re-initialising the provider
      // (the SDK persists the session in local storage) and checking for an
      // authorised account. No account means the session expired — we stay
      // disconnected rather than showing a phantom one.
      if (storedId === WALLETCONNECT_ID && walletConnectConfigured()) {
        const provider = await getWalletConnectProvider();
        if (cancelled() || !provider) {
          if (!cancelled()) setState((s) => ({ ...s, restoring: false }));
          return;
        }
        attach(provider, "walletconnect", WALLETCONNECT_ID);
        restoredRef.current = true;
        lateRestorePendingRef.current = false;
        try {
          const accounts = await provider.request({ method: "eth_accounts" });
          if (cancelled()) return;
          const address = firstAccount(accounts);
          const chainId = address ? await safeChainId(provider) : undefined;
          setState((s) => ({
            ...s,
            restoring: false,
            address,
            chainId,
            status: address ? "connected" : "disconnected",
            connectorId: address ? WALLETCONNECT_ID : undefined,
            kind: address ? "walletconnect" : undefined,
          }));
        } catch {
          if (!cancelled()) setState((s) => ({ ...s, restoring: false }));
        }
        return;
      }

      const restorableId = pickRestorableWallet(storedId, injectedRef.current);
      const wallet = restorableId
        ? injectedRef.current.find((w) => w.id === restorableId)
        : undefined;
      if (!wallet) {
        // A stored injected connector that is not here yet may simply have
        // injected late; the effect below re-tries when it appears.
        lateRestorePendingRef.current = Boolean(storedId && storedId !== WALLETCONNECT_ID);
        if (!cancelled()) setState((s) => ({ ...s, restoring: false }));
        return;
      }
      attach(wallet.provider, "injected", wallet.id);
      restoredRef.current = true;
      lateRestorePendingRef.current = false;
      try {
        const accounts = await wallet.provider.request({ method: "eth_accounts" });
        if (cancelled()) return;
        const address = firstAccount(accounts);
        const chainId = address ? await safeChainId(wallet.provider) : undefined;
        setState((s) => ({
          ...s,
          restoring: false,
          address,
          chainId,
          status: address ? "connected" : "disconnected",
          connectorId: address ? wallet.id : undefined,
          kind: address ? "injected" : undefined,
        }));
      } catch {
        if (!cancelled()) setState((s) => ({ ...s, restoring: false }));
      }
    },
    [attach],
  );

  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    const signal = { cancelled: false };
    const timer = setTimeout(() => void restore(signal), 250);
    return () => {
      signal.cancelled = true;
      clearTimeout(timer);
    };
  }, [restore]);

  // A stored injected wallet that only appears after the first attempt (a late
  // injection) is restored as soon as it shows up. Scoped to the genuinely
  // pending case, so it never fights a deliberate disconnect or manual connect.
  // The attempt is not cancelled on re-render: `restore` marks itself done
  // synchronously once it has attached, so it can never run twice.
  useEffect(() => {
    if (!restoreAttemptedRef.current || restoredRef.current) return;
    if (!lateRestorePendingRef.current) return;
    if (state.status !== "disconnected") return;
    const storedId = readStoredConnector();
    if (!storedId || storedId === WALLETCONNECT_ID) return;
    if (!pickRestorableWallet(storedId, injected)) return;
    void restore({ cancelled: false });
  }, [injected, state.status, restore]);

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
          // `enable()` (equivalently `connect()`) is what starts the pairing
          // flow — it opens the QR modal / deep link and resolves with the
          // authorised accounts. Calling `eth_requestAccounts` alone is answered
          // locally from the current session, which has none yet, so it returned
          // an empty list and the customer was never prompted (the mobile defect).
          let accounts: unknown;
          if (typeof provider.enable === "function") {
            accounts = await provider.enable();
          } else if (typeof provider.connect === "function") {
            await provider.connect({ chains: [NETWORKS.mainnet.chainId] });
            accounts = await provider.request({ method: "eth_accounts" });
          } else {
            accounts = await provider.request({ method: "eth_requestAccounts" });
          }
          const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
          const address = firstAccount(accounts);
          writeStoredConnector(WALLETCONNECT_ID);
          setState((s) => ({
            ...s,
            status: address ? "connected" : "disconnected",
            address,
            chainId: chainIdFromHex(chainIdHex),
            connectorId: WALLETCONNECT_ID,
            kind: "walletconnect",
            restoring: false,
            error: address ? undefined : "The WalletConnect session was closed before an account was shared.",
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
        const address = firstAccount(accounts);
        if (!address) {
          // The wallet answered but shared no account. Say so — do not fall
          // through to a "connected" state with no address, and do not treat
          // this as a WalletConnect prompt.
          setState((s) => ({
            ...s,
            status: "disconnected",
            address: undefined,
            connectorId: undefined,
            kind: undefined,
            restoring: false,
            error:
              "Your wallet didn't share an account. Approve the connection request in your wallet, then try again.",
          }));
          return;
        }
        // Best-effort chain read: a failing read leaves the chain *unknown*
        // rather than blocking a wallet that did authorise the connection.
        const chainId = await safeChainId(wallet.provider);
        writeStoredConnector(wallet.id);
        setState((s) => ({
          ...s,
          status: "connected",
          address,
          chainId,
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
    // The chain read is best-effort for the SAME reason the connect path treats
    // it that way: a page-world injected provider (Trust Wallet) answers
    // `eth_chainId` by proxying to its own node, so the read can fail for
    // reasons unrelated to whether the wallet can pay. A failed read leaves the
    // chain *unknown*; it must not block a payment that is about to be submitted
    // with an explicit chainId (see `lib/wallet/sendTransaction.ts`). Only a
    // wallet that is genuinely on a DIFFERENT chain is asked to switch.
    const current = await safeChainId(provider);
    if (current === undefined || current === target) return { ok: true };
    try {
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
