import { getRoutingProvider } from "@/lib/providers";
import type { MonadNetwork } from "@/lib/config/chains";
import { getToken, type TokenConfig } from "@/lib/config/tokens";
import type { Quote, QuoteResult, QuoteRequest } from "@/lib/domain/intent";
import { validateRecipient, validateUsdAmount } from "@/lib/domain/validation";
import { isQuoteStale } from "@/lib/domain/freshness";
import { buildPaymentPlan, planGasUnits } from "@/lib/execution/plan";
import { estimateNetworkCost } from "./gas";

/**
 * A positional placeholder for the plan-shape gas estimate. The step list a
 * quote produces does not depend on the sender/recipient identity (only which
 * address receives a native-output swap differs), so the total gas is identical
 * for any address. No transaction is ever built or sent with this value.
 */
const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000001" as const;

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

  // Assemble the quote once, then derive the plan's *total* gas from it.
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
    totalSenderCostUsd: payUsd,
    networkCostUsd: 0,
    networkCostUsdAvailable: false,
    gasLimit: routeResult.gasEstimate,
    gasPriceWei: undefined,
    quotedAt: Date.now(),
    exactOutput: routeResult.exactOutput,
    payPriceSource: payPrice.source,
    receivePriceSource: receivePrice.source,
    receivePriceUnavailable: !(receivePrice.usd > 0),
    // Gas is always paid in MON by the standard EOA execution path.
    gas: {
      mode: "native",
      rpc: process.env.ALCHEMY_API_KEY ? "alchemy" : "public",
    },
  };

  // A swap payment is several sequential transactions (approve → swap → unwrap →
  // deliver) and each one charges its own network fee. The wallet must be able
  // to pay the fee of *every* step, so the network cost we display and validate
  // is the plan's total, not a single transaction's. The step composition does
  // not depend on the sender/recipient identity (only the native-output recipient
  // differs), so placeholder addresses are safe for this estimate. A failure to
  // shape the plan must never break the quote — we fall back to the provider's
  // single-transaction estimate.
  let planGas = routeResult.gasEstimate;
  try {
    planGas = planGasUnits(buildPaymentPlan(quote, PLACEHOLDER_ADDRESS, PLACEHOLDER_ADDRESS));
  } catch {
    /* keep the provider's estimate */
  }
  const networkCost = await estimateNetworkCost(network, monPrice, planGas);

  quote.gasLimit = networkCost.gasLimit;
  quote.gasPriceWei = networkCost.gasPriceWei;
  quote.networkCostUsd = networkCost.usd;
  quote.networkCostUsdAvailable = networkCost.usdAvailable;
  quote.totalSenderCostUsd = payUsd + networkCost.usd;

  return { ok: true, quote };
}

/** Re-exported for callers that import staleness from the quote layer. */
export { isQuoteStale };

export type { TokenConfig };
