import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";

/** Build the EIP-3085 payload to add Monad to a wallet. */
export function monadAddChainParams(network: MonadNetwork = "mainnet") {
  const net = NETWORKS[network];
  return {
    chainId: "0x" + net.chainId.toString(16),
    chainName: net.label,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: [net.chain.rpcUrls.default.http[0]],
    blockExplorerUrls: [net.explorer],
  };
}

export function isMonadChain(
  chainIdHex: string | undefined,
  network: MonadNetwork = "mainnet",
) {
  if (!chainIdHex) return false;
  try {
    return parseInt(chainIdHex, 16) === NETWORKS[network].chainId;
  } catch {
    return false;
  }
}
