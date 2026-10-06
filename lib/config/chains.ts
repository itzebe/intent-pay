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
  testnet: true,
});

export type MonadNetwork = "mainnet" | "testnet";

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
