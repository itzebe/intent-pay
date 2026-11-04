import { NextResponse } from "next/server";
import { apiError, apiOk, readJson } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { currentState, getIntent } from "@/lib/developer/intents";
import { checkoutPhase, getCheckoutByToken, recordCheckoutSubmission } from "@/lib/developer/checkouts";
import { drainDueSoon } from "@/lib/developer/webhooks";
import { parseCheckoutSubmission } from "@/lib/developer/requests";
import { isValidCheckoutToken } from "@/lib/developer/checkoutToken";

export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/:token/submit — record the customer's broadcast hash(es).
 *
 * Body: `{ txHash: "0x…" }` or `{ txHashes: ["0x…", …] }`.
 *
 * Token-authenticated. The customer's wallet broadcasts the transaction; this
 * records the hash so the order reflects it, and emits `payment.submitted`. A
 * submitted transaction is **not** a payment — the page keeps showing "submitted"
 * until an independent `verify` proves settlement.
 *
 * Idempotency: a second submit on an already-submitted checkout is refused, so
 * the same transaction cannot be recorded twice.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidCheckoutToken(token)) return apiError("not_found", "No such checkout.");

  const limited = await checkLimit(token, "checkout_public");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const checkout = await getCheckoutByToken(token);
  if (!checkout) return apiError("not_found", "No such checkout.");

  const intent = await getIntent(checkout.developerId, checkout.intentId);
  if (!intent) return apiError("not_found", "This checkout's payment no longer exists.");

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.");
  const parsed = parseCheckoutSubmission(body);
  if ("ok" in parsed) return apiError(parsed.code, parsed.message, undefined, parsed.detail);

  const result = await recordCheckoutSubmission(checkout, intent, parsed.hashes);
  if (!result.ok) return apiError(result.code, result.message);

  // Deliver the `payment.submitted` event after the response is sent.
  await drainDueSoon();

  const state = await currentState(intent.id);
  return apiOk({
    phase: checkoutPhase(checkout, state),
    txHashes: parsed.hashes,
    note: "Submitted, not yet a payment. Settlement is verified independently.",
  });
}
