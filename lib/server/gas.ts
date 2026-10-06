import { getPublicClient } from "@/lib/server/rpc";
import type { MonadNetwork } from "@/lib/config/chains";
import type { TokenConfig } from "@/lib/config/tokens";
import type { UsdPrice } from "@/lib/providers/types";

const DEFAULT_GAS_LIMIT = 350_000n;
const FALLBACK_GAS_PRICE = 101_000_000_000n; // ~101 gwei (observed on Monad mainnet)
const FALLBACK_MON_USD = 0.029;

export type NetworkCost = {
  gasLimit: bigint;
  gasPriceWei: bigint;
  monAmount: number;
  usd: number;
};

/**
 * Estimate the network (gas) cost of a payment. Gas is always paid in MON on
 * Monad. We use the current gas price from the node, falling back to a sane
 * default when the RPC does not report one.
 */
export async function estimateNetworkCost(
  network: MonadNetwork,
  monPrice: UsdPrice,
  gasLimit: bigint = DEFAULT_GAS_LIMIT,
): Promise<NetworkCost> {
  const client = getPublicClient(network);
  let gasPriceWei = FALLBACK_GAS_PRICE;
  try {
    gasPriceWei = await client.getGasPrice();
  } catch {
    /* keep fallback */
  }
  const wei = gasLimit * gasPriceWei;
  const monAmount = Number(wei) / 1e18;
  const usd = monAmount * (monPrice.usd || FALLBACK_MON_USD);
  return { gasLimit, gasPriceWei, monAmount, usd };
}

export function isNativeToken(token: TokenConfig): boolean {
  return Boolean(token.native);
}

