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
  chainIdHex: string | number | undefined,
  network: MonadNetwork = "mainnet",
) {
  const target = NETWORKS[network].chainId;
  if (chainIdHex === undefined || chainIdHex === null) return false;
  // Accept the EIP-1193 hex quantity (`0x8f`) and the decimal form a
  // WalletConnect UniversalProvider returns (143 / "143"), so the same chain is
  // never judged "wrong" depending on which provider answered.
  if (typeof chainIdHex === "number") return chainIdHex === target;
  if (/^0x[0-9a-fA-F]+$/.test(chainIdHex)) return parseInt(chainIdHex, 16) === target;
  if (/^[0-9]+$/.test(chainIdHex)) return parseInt(chainIdHex, 10) === target;
  return false;
}
