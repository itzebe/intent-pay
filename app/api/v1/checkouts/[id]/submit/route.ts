import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { getIntent } from "@/lib/developer/intents";
import { getCheckout, publicCheckout, recordCheckoutSubmission } from "@/lib/developer/checkouts";
import { drainDueSoon } from "@/lib/developer/webhooks";
import { parseCheckoutSubmission } from "@/lib/developer/requests";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/checkouts/:id/submit — record the customer's broadcast hash(es).
 *
 * Body: `{ txHash: "0x…" }` or `{ txHashes: ["0x…", …] }`.
 *
 * The customer's wallet broadcasts; this records the hash so the order reflects
 * that a transaction exists on-chain, and emits `payment.submitted`. A submitted
 * transaction is **not** a payment — only `verify` proves settlement.
 *
 * Duplicate protection: a second submit on an already-submitted checkout is
 * refused, so the same transaction cannot be recorded twice.
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
  const checkout = await getCheckout(auth.auth.developer.id, id);
  if (!checkout) return apiError("not_found", "No such checkout.", auth.requestId);

  const intent = await getIntent(auth.auth.developer.id, checkout.intentId);
  if (!intent) return apiError("not_found", "The bound intent no longer exists.", auth.requestId);

  const body = await readJson(req);
  if (!body) return apiError("invalid_request", "A JSON request body is required.", auth.requestId);
  const parsed = parseCheckoutSubmission(body);
  if ("ok" in parsed) return apiError(parsed.code, parsed.message, auth.requestId, parsed.detail);

  const result = await recordCheckoutSubmission(checkout, intent, parsed.hashes);
  if (!result.ok) return apiError(result.code, result.message, auth.requestId);

  await drainDueSoon();

  return apiOk({
    checkout: publicCheckout(checkout, "submitted"),
    txHashes: parsed.hashes,
    note: "Submitted, not yet a payment. Call verify to prove settlement on-chain.",
  });
}
