import { getRoutingProvider, type AppMode } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { getToken, type TokenConfig } from "@/lib/config/tokens";
import type { Quote, QuoteResult, QuoteRequest } from "@/lib/domain/intent";
import { validateRecipient, validateUsdAmount } from "@/lib/domain/validation";
import { estimateNetworkCost } from "./gas";

/**
 * Intent layer -> quote layer orchestration.
 *
 * Takes a payment intent plus the resolved payment/receive tokens and produces
 * a fully priced Quote (route, both amounts, USD notionals, network cost).
 *
 * Tokens are resolved *before* this call (by symbol or contract address) so a
 * dynamically discovered token flows through exactly like a seed token.
 */
export async function buildQuote(
  req: QuoteRequest,
  mode: AppMode,
  network: MonadNetwork = "mainnet",
): Promise<QuoteResult> {
  const { intent } = req;

  const receiveToken = req.receiveToken ?? getToken(intent.receiveToken);
  const payToken = req.payTokenConfig ?? getToken(req.payToken);
  if (!receiveToken || !payToken) {
    return {
      ok: false,
      code: "unsupported_token",
      message: "That token isn't supported on Monad yet.",
    };
  }

  const recipientIssue = validateRecipient(intent.recipient);
  if (recipientIssue) {
    return { ok: false, code: recipientIssue.code, message: recipientIssue.message };
  }

  // The composer's amount field is a dollar value, so validate it as money.
  const amountIssue = validateUsdAmount(intent.receiveAmount);
  if (amountIssue) {
    return { ok: false, code: amountIssue.code, message: amountIssue.message };
  }

  const provider = getRoutingProvider(mode, network);

  const routeResult = await provider.quote({
    payToken,
    receiveToken,
    mode: intent.amountMode,
    amount: intent.receiveAmount,
    usd: true,
    simulateMove: mode === "demo" ? req.simulateMove : undefined,
    network,
  });

  if (!routeResult.ok) {
    return {
      ok: false,
      code: routeResult.code,
      message: routeResult.message,
      alternatives: routeResult.alternatives,
    };
  }

  const [payPrice, receivePrice] = await Promise.all([
    provider.priceUsd(payToken, network),
    provider.priceUsd(receiveToken, network),
  ]);

  const payUsd = Number(routeResult.payAmount) * payPrice.usd;
  const receiveUsd = Number(routeResult.receiveAmount) * receivePrice.usd;

  const monToken = getToken("MON")!;
  const monPrice = await provider.priceUsd(monToken, network);
  const networkCost = await estimateNetworkCost(network, monPrice, routeResult.gasEstimate);

  const quote: Quote = {
    intent,
    mode,
    network,
    payToken,
    receiveToken,
    payAmount: routeResult.payAmount,
    receiveAmount: routeResult.receiveAmount,
    payUsd,
    receiveUsd,
    rate: routeResult.rate,
    route: routeResult.route,
    totalSenderCostUsd: payUsd + networkCost.usd,
    networkCostUsd: networkCost.usd,
    gasLimit: networkCost.gasLimit,
    gasPriceWei: networkCost.gasPriceWei,
    quotedAt: Date.now(),
    exactOutput: routeResult.exactOutput,
  };

  return { ok: true, quote };
}

/** Re-quote when a previously produced quote is older than `maxAgeMs`. */
export function isQuoteStale(quote: Quote, maxAgeMs = 20_000): boolean {
  return Date.now() - quote.quotedAt > maxAgeMs;
}

export type { TokenConfig };
