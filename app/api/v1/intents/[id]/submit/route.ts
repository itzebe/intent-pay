import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { canonicalParams, currentState, getIntent, transition } from "@/lib/developer/intents";
import { publicIntent } from "@/lib/developer/requests";
import { isValidTxHash } from "@/lib/server/referral/verify";
import { isTerminal } from "@/lib/developer/intentLifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/intents/:id/submit — record the broadcast transaction hash(es).
 *
 * Body: `{ txHash: "0x…" }` or `{ txHashes: ["0x…", …] }`.
 *
 * The transaction is broadcast by the *caller's wallet*, not by this API. This
 * endpoint records the hash(es) so the intent's lifecycle reflects that a
 * transaction now exists on-chain. It requires that the intent was authorized
 * (parameters frozen) — an unauthorized submission is refused, so a hash can
 * never be attached to an intent whose parameters were not committed to.
 *
 * A submitted transaction is **not** a payment: the intent stays `submitted`
 * until `verify` proves settlement from the authoritative chain.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "submit");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const { id } = await params;
  const record = await getIntent(auth.auth.developer.id, id);
  if (!record) return apiError("not_found", "No such intent.", auth.requestId);

  const state = await currentState(record.id);
  if (isTerminal(state)) return apiError("invalid_state", `This intent is ${state}.`, auth.requestId);

  // Authorization is required: submission without frozen parameters is refused.
  if (!record.authorizedParams) {
    return apiError("invalid_state", "Authorize the intent before submitting a transaction.", auth.requestId);
  }
  if (record.authorizedParams !== canonicalParams(record)) {
    return apiError("conflict", "The intent's parameters changed after authorization.", auth.requestId);
  }

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.", auth.requestId);

  const rawList = Array.isArray(body.txHashes) ? body.txHashes : body.txHash !== undefined ? [body.txHash] : [];
  const hashes = rawList.filter((h): h is string => typeof h === "string" && isValidTxHash(h));
  if (hashes.length === 0 || hashes.length !== rawList.length) {
    return apiError("invalid_request", "Provide one or more valid 0x transaction hashes.", auth.requestId, "txHash");
  }

  // Duplicate submission prevention: a second submit on an already-submitted
  // intent is refused, so the same transaction cannot be recorded twice.
  if (state === "submitted" || state === "confirmed" || state === "verified") {
    return apiError("already_submitted", "This intent already has a submitted transaction.", auth.requestId);
  }

  const result = await transition(record, "submitted", `tx:${hashes.join(",")}`.slice(0, 300));
  if (!result.ok) return apiError(result.code, result.message, auth.requestId);

  const updated = await getIntent(auth.auth.developer.id, id);
  return apiOk({
    intent: publicIntent(updated ?? record, "submitted"),
    txHashes: hashes,
    note: "Submitted, not yet a payment. Call verify to prove settlement on-chain.",
  });
}
