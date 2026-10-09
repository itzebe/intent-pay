import { defineChain } from "viem";

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
      http: [
        process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://rpc.monad.xyz",
      ],
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

/** Server-side RPC: Alchemy when configured, else the configured/public RPC. */
export function serverRpcUrl(_network: MonadNetwork = "mainnet"): string {
  return alchemyRpcUrl() ?? process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz";
}

/** Browser-visible RPC (public keys only). */
export function browserRpcUrl(_network: MonadNetwork = "mainnet"): string {
  const pub = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (pub) return `https://monad-mainnet.g.alchemy.com/v2/${pub}`;
  return process.env.NEXT_PUBLIC_MONAD_RPC_URL ?? "https://rpc.monad.xyz";
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
