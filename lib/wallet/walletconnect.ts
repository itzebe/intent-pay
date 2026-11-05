"use client";

import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/config/site";
import { browserRpcUrl, NETWORKS } from "@/lib/config/chains";
import type { Eip1193Provider } from "./eip6963";

/**
 * WalletConnect (Reown) v2 connector.
 *
 * WalletConnect is *opt-in and configuration-gated*: it needs a project id
 * registered at https://dashboard.reown.com (free) exposed to the browser as
 * `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Without it the connector reports
 * "not configured" and the UI offers injected wallets only — it never fakes a
 * session or a QR flow.
 *
 * `@walletconnect/ethereum-provider` is a heavy, browser-only ESM package, so
 * it is loaded with a dynamic `import()` the first time the user actually
 * chooses WalletConnect; nothing is downloaded on a normal page load. The
 * initialized provider is a genuine EIP-1193 provider, so once connected it
 * flows through the *same* `useWallet` path (accounts, chain, signing) as an
 * injected wallet — there is no second payment stack.
 */

/** The public WalletConnect project id, or an empty string when unset. */
export function walletConnectProjectId(): string {
  return (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "").trim();
}

/** True when a WalletConnect project id is configured for the browser. */
export function walletConnectConfigured(): boolean {
  return walletConnectProjectId().length > 0;
}

/** The chain WalletConnect is offered for — Monad Mainnet only. */
const CHAIN_ID = NETWORKS.mainnet.chainId;

let providerPromise: Promise<WalletConnectProvider | null> | null = null;

/**
 * The WalletConnect EIP-1193 provider, plus the extra surface we rely on.
 *
 * `connect()` (not `request({method:"eth_requestAccounts"})`) is what actually
 * starts the pairing flow and opens the QR modal. On the low-level
 * UniversalProvider, `eth_requestAccounts` is answered locally from the
 * *current* session — with no session it returns an empty list without ever
 * prompting. That is the mobile defect: the connect button did nothing.
 */
export type WalletConnectProvider = Eip1193Provider & {
  connect?: (opts?: { chains?: number[]; pairingTopic?: string }) => Promise<void>;
  enable?: () => Promise<string[]>;
  session?: unknown;
  on?: (event: string, handler: (...args: any[]) => void) => void;
};

/**
 * Initialize (once) and return the WalletConnect EIP-1193 provider. Returns
 * `null` when WalletConnect is not configured or the SDK cannot load — the
 * caller must treat that as "unavailable", never as a connection.
 */
export async function getWalletConnectProvider(): Promise<WalletConnectProvider | null> {
  if (!walletConnectConfigured()) return null;
  if (typeof window === "undefined") return null;
  if (!providerPromise) {
    providerPromise = import("@walletconnect/ethereum-provider")
      .then(async ({ EthereumProvider }) => {
        const provider = await EthereumProvider.init({
          projectId: walletConnectProjectId(),
          // Monad Mainnet is the only chain the app talks to; `optionalChains`
          // is the current (non-deprecated) form of `chains`.
          optionalChains: [CHAIN_ID],
          showQrModal: true,
          methods: [
            "eth_sendTransaction",
            "personal_sign",
            "eth_signTypedData_v4",
            "wallet_switchEthereumChain",
            "wallet_addEthereumChain",
          ],
          events: ["chainChanged", "accountsChanged", "disconnect"],
          rpcMap: { [CHAIN_ID]: browserRpcUrl("mainnet") },
          metadata: {
            name: SITE_NAME,
            description: SITE_DESCRIPTION,
            url: window.location.origin || SITE_URL,
            icons: [`${SITE_URL}/icon.svg`],
          },
        });
        return provider as unknown as WalletConnectProvider;
      })
      .catch(() => {
        // A failed init must not be cached as a permanent null, or a transient
        // CDN/network failure would disable WalletConnect for the whole session.
        providerPromise = null;
        return null;
      });
  }
  return providerPromise;
}

/**
 * Tear down the WalletConnect session (and the cached provider) on disconnect,
 * so a later connect shows a fresh QR rather than silently reusing the old
 * session.
 */
export async function resetWalletConnect(): Promise<void> {
  const provider = providerPromise ? await providerPromise.catch(() => null) : null;
  providerPromise = null;
  try {
    await (provider as { disconnect?: () => Promise<void> } | null)?.disconnect?.();
  } catch {
    // A failed teardown must not block a disconnect the user asked for.
  }
}
