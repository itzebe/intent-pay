import type { Address } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import type { Quote, Route } from "@/lib/domain/intent";
import type { TokenConfig } from "@/lib/config/tokens";
import { getRoutingProvider } from "@/lib/providers";
import { splitPayment, type PartialSplit } from "@/lib/domain/partialBalance";

/**
 * Build the two real legs of a partial-balance payment.
 *
 * The user wants the recipient to receive `target` of `targetToken`, but only
 * holds `held` of it and has `sourceToken` funded. We resolve:
 *   - a *direct* leg that transfers the held amount (same-asset quote), and
 *   - a *swap* leg that obtains the shortfall from `sourceToken`.
 *
 * Every number comes from a live quote. We never invent a rate. When the swap
 * leg has no route we return a failure, so the caller refuses rather than
 * pretending the split can execute.
 */

export type PartialLegs = {
  split: PartialSplit;
  /** Same-asset quote for the held amount (pay == receive). */
  directQuote: Quote;
  /** Route quote for the shortfall (source -> target). */
  swapQuote: Quote;
};

export type PartialLegsResult =
  | { ok: true; legs: PartialLegs }
  | { ok: false; code: string; message: string };

export type PartialLegsRequest = {
  targetToken: TokenConfig;
  targetAmount: string;
  held: string;
  sourceToken: TokenConfig;
  sender: Address;
  network: MonadNetwork;
};

export async function buildPartialLegs(req: PartialLegsRequest): Promise<PartialLegsResult> {
  const { targetToken, targetAmount, held, sourceToken, network } = req;
  const split = splitPayment(targetAmount, held, targetToken.decimals);

  if (split.mode === "direct") {
    return { ok: false, code: "no_split", message: "The wallet already holds the full amount." };
  }

  const provider = getRoutingProvider(network);

  // The direct leg is a same-asset transfer: pay == receive == target, amount =
  // what is already held.
  const directRoute: Route = {
    kind: "direct",
    hops: [],
    path: [targetToken.symbol, targetToken.symbol],
    tokens: [targetToken, targetToken],
  };
  const directQuote: Quote = {
    intent: {
      recipient: "",
      receiveToken: targetToken.symbol,
      receiveAmount: split.held,
      amountMode: "recipient_receives",
    },
    network,
    payToken: targetToken,
    receiveToken: targetToken,
    payAmount: split.held,
    receiveAmount: split.held,
    payUsd: 0,
    receiveUsd: 0,
    rate: 1,
    priceImpact: 0,
    route: directRoute,
    totalSenderCostUsd: 0,
    networkCostUsd: 0,
    quotedAt: Date.now(),
    exactOutput: false,
  };

  // The swap leg obtains the shortfall from the source asset.
  const swapResult = await provider.quote({
    payToken: sourceToken,
    receiveToken: targetToken,
    mode: "recipient_receives",
    amount: split.shortfall,
    usd: false,
    network,
  });
  if (!swapResult.ok) {
    return { ok: false, code: swapResult.code, message: swapResult.message };
  }

  const [payPrice, receivePrice] = await Promise.all([
    provider.priceUsd(sourceToken, network).catch(() => ({ usd: 0, source: "fallback" as const })),
    provider.priceUsd(targetToken, network).catch(() => ({ usd: 0, source: "fallback" as const })),
  ]);
  const swapQuote: Quote = {
    intent: {
      recipient: "",
      receiveToken: targetToken.symbol,
      receiveAmount: split.shortfall,
      amountMode: "recipient_receives",
    },
    network,
    payToken: sourceToken,
    receiveToken: targetToken,
    payAmount: swapResult.payAmount,
    receiveAmount: swapResult.receiveAmount,
    payUsd: Number(swapResult.payAmount) * payPrice.usd,
    receiveUsd: Number(swapResult.receiveAmount) * receivePrice.usd,
    rate: swapResult.rate,
    priceImpact: swapResult.priceImpact ?? null,
    route: swapResult.route,
    totalSenderCostUsd: Number(swapResult.payAmount) * payPrice.usd,
    networkCostUsd: 0,
    quotedAt: Date.now(),
    exactOutput: swapResult.exactOutput,
    payPriceSource: payPrice.source,
    receivePriceSource: receivePrice.source,
    receivePriceUnavailable: !(receivePrice.usd > 0),
  };

  return { ok: true, legs: { split, directQuote, swapQuote } };
}
