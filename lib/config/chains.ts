import { defineChain } from "viem";

/**
 * The public Monad Mainnet RPC. It needs no key and is the last-resort
 * endpoint for every chain read, so a rate-limited or unavailable keyed
 * provider can never make the app unable to read Monad.
 */
export const PUBLIC_MONAD_RPC = "https://rpc.monad.xyz";

/**
 * Monad Mainnet.
 *
 * Intent Pay is mainnet-only. There is no testnet configuration and no
 * automatic network fallback: every read, quote, and transaction targets
 * Monad Mainnet (chain id 143). If a wallet is on another chain we ask the
 * user to switch rather than executing anywhere else.
 */
export const monadMainnet = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      // A list, most-preferred first, so a wallet's `wallet_addEthereumChain`
      // has a working endpoint even when the keyed provider is rate limited.
      http: browserRpcUrls(),
    },
  },
  blockExplorers: {
    default: { name: "MonadScan", url: "https://monadscan.com" },
  },
  contracts: {
    // Canonical Multicall3 — used to discover pools and read balances in bulk.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: false,
});

/** The only network the production application talks to. */
export type MonadNetwork = "mainnet";

/**
 * Alchemy RPC endpoint for Monad Mainnet, when an API key is configured.
 *
 * Alchemy serves Monad Mainnet and provides the indexed RPC node. When no key
 * is present we fall back to the public mainnet RPC and nothing else changes.
 * Gas is always paid in MON; Alchemy is not used for account abstraction.
 */
export function alchemyRpcUrl(_network: MonadNetwork = "mainnet"): string | null {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return null;
  return `https://monad-mainnet.g.alchemy.com/v2/${key}`;
}

function dedupe(urls: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * Browser RPC endpoints, most-preferred first.
 *
 * A keyed provider is tried first when configured, but the public RPC is always
 * appended. A browser client built on `fallback(...)` (see `lib/wallet/clients`)
 * then survives a rate-limited or unavailable keyed endpoint instead of failing
 * every chain read — which is what a receipt wait or a balance read would
 * otherwise do on a mobile connection.
 */
export function browserRpcUrls(_network: MonadNetwork = "mainnet"): string[] {
  const pub = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  return dedupe([
    pub ? `https://monad-mainnet.g.alchemy.com/v2/${pub}` : null,
    process.env.NEXT_PUBLIC_MONAD_RPC_URL,
    PUBLIC_MONAD_RPC,
  ]);
}

/**
 * Server-side RPC endpoints, most-preferred first.
 *
 * The keyed Alchemy node is preferred, but the public RPC is always appended so
 * a 429 / outage on the keyed endpoint degrades to the public node rather than
 * producing an empty routing graph (which would be misread as "no route").
 */
export function serverRpcUrls(_network: MonadNetwork = "mainnet"): string[] {
  return dedupe([alchemyRpcUrl(), process.env.MONAD_RPC_URL, PUBLIC_MONAD_RPC]);
}

/** Server-side RPC: Alchemy when configured, else the configured/public RPC. */
export function serverRpcUrl(_network: MonadNetwork = "mainnet"): string {
  return serverRpcUrls()[0];
}

/** Browser-visible RPC (public keys only). */
export function browserRpcUrl(_network: MonadNetwork = "mainnet"): string {
  return browserRpcUrls()[0];
}

export const NETWORKS = {
  mainnet: {
    key: "mainnet" as const,
    chain: monadMainnet,
    chainId: 143,
    label: "Monad",
    explorer: "https://monadscan.com",
  },
};

export function networkFor(_key: MonadNetwork = "mainnet") {
  return NETWORKS.mainnet;
}

/** Address that represents the native asset (MON) across the app. */
export const NATIVE_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export function isNative(address: string): boolean {
  return address.toLowerCase() === NATIVE_ADDRESS;
}

export function explorerTxUrl(_network: MonadNetwork, hash: string): string {
  return `${NETWORKS.mainnet.explorer}/tx/${hash}`;
}

export function explorerAddressUrl(_network: MonadNetwork, address: string): string {
  return `${NETWORKS.mainnet.explorer}/address/${address}`;
}
