import { getRoutingProvider } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { getToken, type TokenConfig } from "@/lib/config/tokens";
import type { Quote, QuoteResult, QuoteRequest } from "@/lib/domain/intent";
import { validateRecipient, validateUsdAmount } from "@/lib/domain/validation";
import { isQuoteStale } from "@/lib/domain/freshness";
import { estimateNetworkCost } from "./gas";
import { gasCapabilities } from "./gasCapabilities";

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

  const provider = getRoutingProvider(network);

  const routeResult = await provider.quote({
    payToken,
    receiveToken,
    mode: intent.amountMode,
    amount: intent.receiveAmount,
    usd: true,

    network,
  });

  if (!routeResult.ok) {
    // The requested tokens can't be alternatives to themselves.
    const alternatives = routeResult.alternatives?.filter(
      (s) => s !== payToken.symbol && s !== receiveToken.symbol,
    );
    return {
      ok: false,
      code: routeResult.code,
      message: routeResult.message,
      alternatives,
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

  const caps = gasCapabilities(network);

  const quote: Quote = {
    intent,
    network,
    payToken,
    receiveToken,
    payAmount: routeResult.payAmount,
    receiveAmount: routeResult.receiveAmount,
    payUsd,
    receiveUsd,
    rate: routeResult.rate,
    priceImpact: routeResult.priceImpact ?? null,
    route: routeResult.route,
    totalSenderCostUsd: payUsd + networkCost.usd,
    networkCostUsd: networkCost.usd,
    networkCostUsdAvailable: networkCost.usdAvailable,
    gasLimit: networkCost.gasLimit,
    gasPriceWei: networkCost.gasPriceWei,
    quotedAt: Date.now(),
    exactOutput: routeResult.exactOutput,
    payPriceSource: payPrice.source,
    receivePriceSource: receivePrice.source,
    receivePriceUnavailable: !(receivePrice.usd > 0),
    // Gas handling is reported honestly: sponsorship / ERC-20 gas is only
    // offered when an Alchemy gas policy is configured; the wallet must also
    // advertise the capability (checked in the browser) for it to actually be
    // used, so a quote never overclaims sponsorship it can't deliver.
    gas: {
      mode: caps.sponsorshipConfigured ? "sponsored" : "native",
      sponsorshipConfigured: caps.sponsorshipConfigured,
      rpc: caps.rpc,
    },
  };

  return { ok: true, quote };
}

/** Re-exported for callers that import staleness from the quote layer. */
export { isQuoteStale };

export type { TokenConfig };
