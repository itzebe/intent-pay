import { formatUnits, parseUnits } from "viem";
import type { TokenConfig } from "@/lib/config/tokens";
import { TOKENS, getToken } from "@/lib/config/tokens";
import { getPublicClient } from "@/lib/server/rpc";
import type { MonadNetwork } from "@/lib/config/chains";
import type { Balance } from "@/lib/domain/intent";
import type { UsdPrice } from "@/lib/providers/types";

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function readBalances(
  address: `0x${string}`,
  network: MonadNetwork,
  priceOf: (token: TokenConfig) => Promise<UsdPrice>,
): Promise<Balance[]> {
  const client = getPublicClient(network);

  return Promise.all(
    TOKENS.map(async (token) => {
      try {
        let amount = 0n;
        if (token.native) {
          amount = await client.getBalance({ address });
        } else {
          amount = (await client.readContract({
            address: token.address,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          })) as bigint;
        }
        const price = await priceOf(token);
        const amountStr = formatUnits(amount, token.decimals);
        return {
          token,
          amount: amountStr,
          usd: Number(amountStr) * price.usd,
        } satisfies Balance;
      } catch {
        return { token, amount: "0", usd: 0 } satisfies Balance;
      }
    }),
  );
}

/** Convenience: read a single token balance. */
export async function readTokenBalance(
  address: `0x${string}`,
  symbol: string,
  network: MonadNetwork,
): Promise<string> {
  const token = getToken(symbol);
  if (!token) return "0";
  const client = getPublicClient(network);
  try {
    if (token.native) {
      const b = await client.getBalance({ address });
      return formatUnits(b, token.decimals);
    }
    const b = (await client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
    return formatUnits(b, token.decimals);
  } catch {
    return "0";
  }
}

export function hasSufficientBalance(
  balance: string,
  required: string,
  decimals: number,
  gasReserve = 0n,
): boolean {
  try {
    return parseUnits(balance, decimals) >= parseUnits(required, decimals) + gasReserve;
  } catch {
    return false;
  }
}
