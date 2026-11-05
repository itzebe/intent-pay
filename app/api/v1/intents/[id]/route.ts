import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { getIntent, intentEvents, expireIfStale } from "@/lib/developer/intents";
import { publicIntent } from "@/lib/developer/requests";
import { drainDueSoon } from "@/lib/developer/webhooks";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/intents/:id — retrieve an intent and its lifecycle.
 *
 * The current state is derived from the append-only event history, so it cannot
 * be out of step with the history. The read is scoped to the authenticated
 * developer: another tenant's intent is reported as `not_found`, never as a 403
 * (which would confirm the id exists).
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
  const record = await getIntent(auth.auth.developer.id, id);
  if (!record) return apiError("not_found", "No such intent.", auth.requestId);

  // A stale pre-submission intent ages into `expired` on read.
  const state = await expireIfStale(record);
  const events = await intentEvents(record.id);
  // Expiring a stale intent emits `intent.expired`; deliver it after the response.
  await drainDueSoon();
  return apiOk({
    intent: publicIntent(record, state),
    lifecycle: events.map((e) => ({ state: e.state, at: new Date(e.at).toISOString(), detail: e.detail })),
  });
}
