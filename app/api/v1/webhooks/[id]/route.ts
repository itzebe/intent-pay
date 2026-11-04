import { NextResponse } from "next/server";
import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { deleteWebhook } from "@/lib/developer/webhooks";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/v1/webhooks/:id — delete a webhook destination.
 *
 * Scoped to the authenticated developer; another tenant's webhook is reported as
 * `not_found`. Pending deliveries for the webhook are removed with it.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "write");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const { id } = await params;
  const removed = await deleteWebhook(auth.auth.developer.id, id);
  if (!removed) return apiError("not_found", "No such webhook.", auth.requestId);
  return apiOk({ deleted: true, id });
}
