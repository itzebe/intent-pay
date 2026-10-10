import type { MonadNetwork } from "@/lib/config/chains";
import type { AmountMode, Balance, PaymentIntent } from "@/lib/domain/intent";
import { parseUnits } from "@/lib/domain/math";
import type { TokenConfig } from "@/lib/config/tokens";

import { buildQuote } from "./quote";
import { quoteGasReserveWei } from "@/lib/domain/gasReserve";

/**
 * Payment optimizer.
 *
 * Given the user's intent and what they actually hold, evaluate every funded
 * asset as a candidate *source* of the payment and rank them. The ranking is
 * total sender cost (what they spend + network cost), and an option is only
 * eligible when the wallet holds enough of it. This is what turns "you have
 * USDT and USDC — which should we spend?" into a single recommended answer
 * without the user reasoning about routes or gas.
 */
export type PaymentOption = {
  symbol: string;
  token: TokenConfig;
  ok: boolean;
  payAmount?: string;
  payUsd?: number;
  receiveAmount?: string;
  receiveUsd?: number;
  routePath?: string[];
  networkCostUsd?: number;
  totalSenderCostUsd?: number;
  /** True when the wallet holds enough of this asset (incl. a MON gas reserve). */
  sufficient: boolean;
  reason?: string;
};

export type OptimizeResult = {
  amountMode: AmountMode;
  best: PaymentOption | null;
  options: PaymentOption[];
};

/** Only evaluate the most valuable holdings — enough to find the best route. */
const MAX_CANDIDATES = 6;

/**
 * Whether the wallet holds enough of the source asset to pay, keeping a
 * *gas-derived* reserve aside when the source is native MON itself. The reserve
 * is the quote's own `gasLimit × maxFeePerGas`, not a flat amount, so a small
 * native payment is only rejected when it genuinely cannot cover its fee.
 */
function heldEnough(
  token: TokenConfig,
  balance: Balance | undefined,
  payAmount: string,
  reserveWei: bigint,
): boolean {
  if (!balance) return false;
  try {
    const required = parseUnits(payAmount, token.decimals);
    const available = parseUnits(balance.amount, token.decimals);
    const reserve = token.native ? reserveWei : 0n;
    return available >= required + reserve;
  } catch {
    return false;
  }
}

export async function optimizePayment(
  intent: PaymentIntent,
  balances: Balance[],
  network: MonadNetwork = "mainnet",
): Promise<OptimizeResult> {
  const funded = balances
    .filter((b) => b.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, MAX_CANDIDATES);

  const bySymbol = new Map(balances.map((b) => [b.token.symbol, b]));

  const options = await Promise.all(
    funded.map(async (b): Promise<PaymentOption> => {
      try {
        const res = await buildQuote(
          {
            intent,
            payToken: b.token.symbol,
            payTokenConfig: b.token,
            network,
          },
          network,
        );
        if (!res.ok) {
          return {
            symbol: b.token.symbol,
            token: b.token,
            ok: false,
            sufficient: false,
            reason: res.message,
          };
        }
        const q = res.quote;
        return {
          symbol: b.token.symbol,
          token: b.token,
          ok: true,
          payAmount: q.payAmount,
          payUsd: q.payUsd,
          receiveAmount: q.receiveAmount,
          receiveUsd: q.receiveUsd,
          routePath: q.route.path,
          networkCostUsd: q.networkCostUsd,
          totalSenderCostUsd: q.totalSenderCostUsd,
          // A native MON source must keep its own gas fee aside; the reserve is
          // this quote's gasLimit × maxFeePerGas, not a flat amount.
          sufficient: heldEnough(b.token, bySymbol.get(b.token.symbol), q.payAmount, quoteGasReserveWei(q)),
        };
      } catch {
        return {
          symbol: b.token.symbol,
          token: b.token,
          ok: false,
          sufficient: false,
          reason: "could not be priced",
        };
      }
    }),
  );

  const eligible = options.filter((o) => o.ok && o.sufficient);

  // "They receive X": spend the least to deliver the exact amount.
  // "I spend X": deliver the most for the fixed spend.
  const ranked = [...eligible].sort((a, b) => {
    if (intent.amountMode === "i_spend") {
      return (b.receiveUsd ?? 0) - (a.receiveUsd ?? 0);
    }
    return (a.totalSenderCostUsd ?? Infinity) - (b.totalSenderCostUsd ?? Infinity);
  });

  return {
    amountMode: intent.amountMode,
    best: ranked[0] ?? null,
    options: [...ranked, ...options.filter((o) => !o.ok || !o.sufficient)],
  };
}
