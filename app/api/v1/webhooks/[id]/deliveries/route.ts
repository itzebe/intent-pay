import { NextResponse } from "next/server";
import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { getWebhook, listDeliveries } from "@/lib/developer/webhooks";
import { publicDelivery } from "@/lib/developer/requests";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/webhooks/:id/deliveries — the delivery history for a webhook.
 *
 * Returns the real attempt record: status, attempt count, the last HTTP status
 * code and a short error. The payload is not returned (the receiver already has
 * it, and it may be large); the `eventId` is, so a receiver can reconcile a
 * duplicate it recorded. Scoped to the authenticated developer.
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
  const hook = await getWebhook(auth.auth.developer.id, id);
  if (!hook) return apiError("not_found", "No such webhook.", auth.requestId);

  const deliveries = await listDeliveries(auth.auth.developer.id, id, 50);
  return apiOk({ webhookId: id, deliveries: deliveries.map(publicDelivery) });
}
