import { defineChain } from "viem";

/**
 * Monad mainnet + testnet definitions.
 * Monad is an EVM-equivalent L1 (chain id 143 mainnet / 10143 testnet).
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

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ??
          "https://testnet-rpc.monad.xyz",
      ],
    },
  },
  blockExplorers: {
    default: { name: "MonadScan Testnet", url: "https://testnet.monadscan.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

export type MonadNetwork = "mainnet" | "testnet";

/**
 * Alchemy RPC endpoint for a network, when an API key is configured.
 *
 * Alchemy serves Monad mainnet + testnet. Using it as the transport upgrades the
 * whole app (reads, gas estimation, receipts) to an indexed node; when no key is
 * present we fall back to the public RPC and nothing else changes.
 */
export function alchemyRpcUrl(network: MonadNetwork): string | null {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) return null;
  const slug = network === "mainnet" ? "monad-mainnet" : "monad-testnet";
  return `https://${slug}.g.alchemy.com/v2/${key}`;
}

/** Server-side RPC: Alchemy when configured, else the configured/public RPC. */
export function serverRpcUrl(network: MonadNetwork): string {
  return (
    alchemyRpcUrl(network) ??
    (network === "mainnet"
      ? process.env.MONAD_RPC_URL ?? "https://rpc.monad.xyz"
      : process.env.MONAD_TESTNET_RPC_URL ?? "https://testnet-rpc.monad.xyz")
  );
}

/** Browser-visible RPC (public keys only). */
export function browserRpcUrl(network: MonadNetwork): string {
  const pub = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  if (pub) {
    const slug = network === "mainnet" ? "monad-mainnet" : "monad-testnet";
    return `https://${slug}.g.alchemy.com/v2/${pub}`;
  }
  return (
    (network === "mainnet"
      ? process.env.NEXT_PUBLIC_MONAD_RPC_URL
      : process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL) ??
    (network === "mainnet" ? "https://rpc.monad.xyz" : "https://testnet-rpc.monad.xyz")
  );
}

export const NETWORKS = {
  mainnet: {
    key: "mainnet" as const,
    chain: monadMainnet,
    chainId: 143,
    label: "Monad",
    explorer: "https://monadscan.com",
  },
  testnet: {
    key: "testnet" as const,
    chain: monadTestnet,
    chainId: 10143,
    label: "Monad Testnet",
    explorer: "https://testnet.monadscan.com",
  },
};

export function networkFor(key: MonadNetwork) {
  return NETWORKS[key];
}

/** Address that represents the native asset (MON) across the app. */
export const NATIVE_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export function isNative(address: string): boolean {
  return address.toLowerCase() === NATIVE_ADDRESS;
}

export function explorerTxUrl(network: MonadNetwork, hash: string): string {
  return `${NETWORKS[network].explorer}/tx/${hash}`;
}

export function explorerAddressUrl(network: MonadNetwork, address: string): string {
  return `${NETWORKS[network].explorer}/address/${address}`;
}
