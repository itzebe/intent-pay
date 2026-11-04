import { NextResponse } from "next/server";
import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent, isAuthorizedOrBeyond, transition } from "@/lib/developer/intents";
import { validateIntentRecord } from "@/lib/developer/engine";
import { isTerminal, type IntentState } from "@/lib/developer/intentLifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/intents/:id/validate — validate recipient, asset, chain, amount
 * and payment constraints against the live catalog and a real route check.
 *
 * On success the intent advances `validated`; a failed validation records
 * `rejected` with the specific reasons, so the lifecycle reflects reality rather
 * than leaving a doomed intent "created" forever.
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
  const record = await getIntent(auth.auth.developer.id, id);
  if (!record) return apiError("not_found", "No such intent.", auth.requestId);

  const state = await currentState(record.id);
  if (isTerminal(state)) return apiError("invalid_state", `This intent is ${state}.`, auth.requestId);
  if (isAuthorizedOrBeyond(state)) {
    return apiError("invalid_state", "This intent has already been authorized; its parameters are frozen.", auth.requestId);
  }

  const outcome = await validateIntentRecord(record);
  if (!outcome.ok) {
    // Record the rejection with the concrete reasons (never a bare failure).
    const reasons = [
      !outcome.recipient.valid ? `recipient: ${outcome.recipient.reason}` : null,
      !outcome.amount.valid ? `amount: ${outcome.amount.reason}` : null,
      !outcome.receiveToken.exists ? `asset: ${outcome.receiveToken.reason ?? "unknown"}` : null,
      outcome.route && !outcome.route.available ? `route: ${outcome.route.reason ?? "unavailable"}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    const current = await currentState(record.id);
    if (current === "created") await transition(record, "validating", null);
    await transition(record, "rejected", reasons.slice(0, 300));
    return apiOk({ valid: false, validation: outcome, state: "rejected" satisfies IntentState });
  }

  const current = await currentState(record.id);
  if (current === "created") await transition(record, "validating", null);
  await transition(record, "validated", null);
  return apiOk({ valid: true, validation: outcome, state: "validated" satisfies IntentState });
}
