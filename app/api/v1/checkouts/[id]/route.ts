import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent } from "@/lib/developer/intents";
import { checkoutLifecycle, expireCheckoutIfStale, getCheckout, publicCheckout } from "@/lib/developer/checkouts";
import { drainDueSoon } from "@/lib/developer/webhooks";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/checkouts/:id — retrieve a checkout and its order state.
 *
 * The status is derived from the bound intent's real lifecycle, so a checkout
 * reports `completed` only when the intent is `verified`. The read is scoped to
 * the authenticated developer: another tenant's checkout is `not_found`, never a
 * 403.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "read");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const { id } = await params;
  const checkout = await getCheckout(auth.auth.developer.id, id);
  if (!checkout) return apiError("not_found", "No such checkout.", auth.requestId);

  // A stale open checkout ages into `expired` on read.
  const status = await expireCheckoutIfStale(checkout);
  const intent = await getIntent(auth.auth.developer.id, checkout.intentId);
  const intentState = intent ? await currentState(intent.id) : "expired";
  const lifecycle = await checkoutLifecycle(checkout.intentId);
  // Expiring a stale order emits `checkout.expired`; deliver it after the response.
  await drainDueSoon();

  return apiOk({
    checkout: { ...publicCheckout(checkout, intentState), status },
    intent: intent
      ? {
          id: intent.id,
          state: intentState,
          chainId: intent.chainId,
          recipient: intent.recipient,
          receiveToken: intent.receiveToken,
          receiveTokenAddress: intent.receiveTokenAddress,
          amountMode: intent.amountMode,
          amount: intent.amount,
          payToken: intent.payToken,
          authorized: intent.authorizedParams !== null,
        }
      : null,
    lifecycle,
  });
}
