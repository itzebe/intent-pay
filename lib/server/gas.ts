import { getPublicClient } from "@/lib/server/rpc";
import type { MonadNetwork } from "@/lib/config/chains";
import type { TokenConfig } from "@/lib/config/tokens";
import type { UsdPrice } from "@/lib/providers/types";

const DEFAULT_GAS_LIMIT = 350_000n;
const FALLBACK_GAS_PRICE = 101_000_000_000n; // ~101 gwei (observed on Monad mainnet)

export type NetworkCost = {
  gasLimit: bigint;
  gasPriceWei: bigint;
  monAmount: number;
  /** USD value of the gas, or 0 when no live MON price was available. */
  usd: number;
  /** False when the USD value could not be derived from live data. */
  usdAvailable: boolean;
};

/**
 * Estimate the network (gas) cost of a payment. Gas is always paid in MON on
 * Monad. We use the current gas price from the node, falling back to a sane
 * default when the RPC does not report one.
 *
 * The USD notional is derived strictly from the live MON price. When there is
 * no live price we return `usdAvailable: false` and a zero value so the UI can
 * say the cost is unavailable rather than showing a fabricated dollar figure.
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
  const priceable = monPrice.usd > 0;
  const usd = priceable ? monAmount * monPrice.usd : 0;
  return { gasLimit, gasPriceWei, monAmount, usd, usdAvailable: priceable };
}

export function isNativeToken(token: TokenConfig): boolean {
  return Boolean(token.native);
}

