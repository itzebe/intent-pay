import { NextResponse } from "next/server";
import { apiError, apiOk } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent } from "@/lib/developer/intents";
import {
  checkoutPhase,
  checkoutTxHashes,
  expireCheckoutIfStale,
  getCheckoutByToken,
  publicCheckoutForCustomer,
} from "@/lib/developer/checkouts";
import { isValidCheckoutToken } from "@/lib/developer/checkoutToken";

export const dynamic = "force-dynamic";

/**
 * GET /api/checkout/:token — the public, customer-facing view of a checkout.
 *
 * This is the only endpoint a customer's browser calls directly, and it is
 * authenticated by the payment-link token, not an API key (the customer has no
 * credential, and must never be given the merchant's). The token grants access
 * to exactly one order: it exposes what is being paid and to whom, never another
 * checkout, the merchant's tenant id, or any other tenant data.
 *
 * The response is always the *current* truth: the phase is derived from the bound
 * intent's real lifecycle, so the page can never show "paid" before the chain
 * proves it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidCheckoutToken(token)) return apiError("not_found", "No such checkout.");

  const limited = await checkLimit(token, "checkout_public");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const checkout = await getCheckoutByToken(token);
  if (!checkout) return apiError("not_found", "No such checkout.");

  await expireCheckoutIfStale(checkout);
  const intent = await getIntent(checkout.developerId, checkout.intentId);
  if (!intent) return apiError("not_found", "This checkout's payment no longer exists.");

  const state = await currentState(intent.id);
  const txHashes = await checkoutTxHashes(intent.id);
  return apiOk({
    checkout: publicCheckoutForCustomer(checkout, intent, state),
    phase: checkoutPhase(checkout, state),
    txHashes,
  });
}
