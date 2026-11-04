import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent } from "@/lib/developer/intents";
import { cancelCheckout, getCheckout, publicCheckout } from "@/lib/developer/checkouts";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/checkouts/:id/cancel — cancel an eligible checkout.
 *
 * Only an open, unpaid checkout can be canceled. A checkout with a submitted,
 * confirmed or verified transaction is refused (`invalid_state`), because
 * canceling it would discard a real payment. Canceling also expires the bound
 * intent, so the customer's payment page stops offering the order.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "write");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const { id } = await params;
  const checkout = await getCheckout(auth.auth.developer.id, id);
  if (!checkout) return apiError("not_found", "No such checkout.", auth.requestId);

  const result = await cancelCheckout(checkout);
  if (!result.ok) return apiError(result.code, result.message, auth.requestId);

  const intent = await getIntent(auth.auth.developer.id, checkout.intentId);
  const intentState = intent ? await currentState(intent.id) : "expired";
  return apiOk({ checkout: publicCheckout(checkout, intentState), canceled: true });
}
