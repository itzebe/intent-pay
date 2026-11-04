import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { canonicalParams, checkoutSubmittedHash, currentState, getIntent } from "@/lib/developer/intents";
import { checkoutStatus, getCheckout, publicCheckout, recordCheckoutFailure, recordCheckoutVerified } from "@/lib/developer/checkouts";
import { verifySettlement } from "@/lib/developer/settlement";
import { isValidTxHash } from "@/lib/server/referral/verify";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/checkouts/:id/verify — independently verify settlement on-chain.
 *
 * Body: `{ txHash?: "0x…" }` (defaults to the hash recorded at submit).
 *
 * The server reads the authoritative Monad receipt itself and proves the
 * recipient received the requested asset. Only a `verified` verdict completes
 * the order (and emits `payment.confirmed` then `payment.verified`). A reverted
 * or short settlement emits `payment.failed`. `pending` / `not_found` /
 * `unavailable` leaves the order submitted and asks the caller to retry — the
 * order is never falsely completed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireDeveloper(req);
  if (!auth.ok) return auth.response;

  const limited = await checkLimit(auth.auth.developer.id, "verify");
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  const { id } = await params;
  const checkout = await getCheckout(auth.auth.developer.id, id);
  if (!checkout) return apiError("not_found", "No such checkout.", auth.requestId);

  const intent = await getIntent(auth.auth.developer.id, checkout.intentId);
  if (!intent) return apiError("not_found", "The bound intent no longer exists.", auth.requestId);

  const state = await currentState(intent.id);
  if (state === "verified") {
    // Idempotent: an already-verified order returns its verdict.
    return apiOk({ verdict: "verified", state, checkout: publicCheckout(checkout, "verified") });
  }

  const body = await readJson(req);
  const explicit = typeof body?.txHash === "string" && isValidTxHash(body.txHash) ? body.txHash : null;
  const txHash = explicit ?? (await checkoutSubmittedHash(intent.id));
  if (!txHash) {
    return apiError("invalid_request", "No transaction hash to verify. Submit one, or pass `txHash`.", auth.requestId, "txHash");
  }

  if (intent.authorizedParams && intent.authorizedParams !== canonicalParams(intent)) {
    return apiError("conflict", "The intent's parameters changed after authorization.", auth.requestId);
  }

  const check = await verifySettlement({
    txHash,
    recipient: intent.recipient,
    receiveTokenAddress: intent.receiveTokenAddress,
    receiveToken: intent.receiveToken,
    expectedAmount: intent.amount,
  });

  if (check.verdict === "verified") {
    const finalState = await recordCheckoutVerified(checkout, intent, check.delivered ?? "", check.blockNumber);
    return apiOk({ verdict: check.verdict, state: finalState, checkout: publicCheckout(checkout, finalState), settlement: check });
  }

  if (check.verdict === "reverted" || check.verdict === "short") {
    const finalState = await recordCheckoutFailure(checkout, intent, `${check.verdict}: ${check.message}`);
    return apiOk({ verdict: check.verdict, state: finalState, checkout: publicCheckout(checkout, finalState), settlement: check });
  }
  // pending / not_found / unavailable / invalid_hash — the order stays where it is.
  return apiOk({ verdict: check.verdict, state, status: checkoutStatus(checkout, state), settlement: check, retryable: true });
}
