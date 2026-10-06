import { getToken, type TokenConfig } from "@/lib/config/tokens";
import type { Balance } from "@/lib/domain/intent";

/**
 * Demo wallet. Amounts are derived from token config so the sample wallet is a
 * realistic Monad mix: ~$20 USDT, ~$8 USDC, ~$3 MON. This is clearly labelled
 * demo data everywhere it is used.
 */
export const DEMO_ADDRESS = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;

const DEMO_USD: Record<string, number> = {
  USDT: 20,
  USDC: 8,
  MON: 3,
};

export function demoBalances(): Balance[] {
  return Object.entries(DEMO_USD).map(([symbol, usd]) => {
    const token = getToken(symbol) as TokenConfig;
    const amount = usd / token.fallbackUsd;
    return {
      token,
      amount: amount.toFixed(token.decimals > 6 ? 6 : token.decimals),
      usd,
    } satisfies Balance;
  });
}

/** A second demo wallet with no funds, used to demonstrate insufficient balance. */
export function emptyDemoBalances(): Balance[] {
  return demoBalances().map((b) => ({ ...b, amount: "0", usd: 0 }));
}
