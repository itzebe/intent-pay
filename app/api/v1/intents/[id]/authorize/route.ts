import { NextResponse } from "next/server";
import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { canonicalParams, currentState, freezeParams, getIntent, transition } from "@/lib/developer/intents";
import { publicIntent } from "@/lib/developer/requests";
import { isTerminal } from "@/lib/developer/intentLifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/intents/:id/authorize — freeze the parameters before signing.
 *
 * This is the point of no return for the *request*: the exact recipient, asset
 * and amount are written to `authorizedParams` and become immutable. From here a
 * prepare/submit/verify must match them byte-for-byte, so a recipient or amount
 * can never be swapped after authorization.
 *
 * Authorizing does **not** sign or send anything. It records the developer's
 * intent to pay these exact parameters with their own wallet.
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

  // Idempotent: re-authorizing returns the same frozen parameters.
  if (record.authorizedParams) {
    if (record.authorizedParams !== canonicalParams(record)) {
      return apiError("conflict", "The intent's parameters changed after authorization.", auth.requestId);
    }
    return apiOk({ intent: publicIntent(record, state), authorizedParams: JSON.parse(record.authorizedParams), state });
  }

  if (state !== "prepared" && state !== "validated") {
    return apiError("invalid_state", "Prepare (or validate) the intent before authorizing it.", auth.requestId);
  }

  // Freeze first, then move the state machine, so a crash between the two leaves
  // the parameters frozen (the safe direction).
  await freezeParams(record);
  if (state === "validated") await transition(record, "prepared", null);
  await transition(record, "awaiting_authorization", null);

  const frozen = await getIntent(auth.auth.developer.id, id);
  const newState = await currentState(record.id);
  return apiOk({
    intent: publicIntent(frozen ?? record, newState),
    authorizedParams: JSON.parse(frozen?.authorizedParams ?? canonicalParams(record)),
    state: newState,
  });
}
