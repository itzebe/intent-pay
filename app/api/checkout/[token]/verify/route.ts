import { NextResponse } from "next/server";
import { apiError, apiOk, readJson } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { canonicalParams, checkoutSubmittedHash, currentState, getIntent } from "@/lib/developer/intents";
import { checkoutPhase, checkoutStatus, getCheckoutByToken, recordCheckoutFailure, recordCheckoutVerified } from "@/lib/developer/checkouts";
import { verifySettlement } from "@/lib/developer/settlement";
import { isValidTxHash } from "@/lib/server/referral/verify";
import { isValidCheckoutToken } from "@/lib/developer/checkoutToken";

export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/:token/verify — independently verify settlement on-chain.
 *
 * Token-authenticated. The server reads the authoritative Monad receipt itself
 * and proves the recipient received the requested asset. Only a `verified`
 * verdict completes the order; a reverted/short settlement fails it; `pending` /
 * `not_found` / `unavailable` leaves it submitted and asks the caller to retry.
 * The page therefore never shows "paid" before the chain confirms delivery.
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

  const state = await currentState(intent.id);
  if (state === "verified") {
    return apiOk({ verdict: "verified", phase: "payment_verified", status: "completed" });
  }

  const body = await readJson(req);
  const explicit = typeof body?.txHash === "string" && isValidTxHash(body.txHash) ? body.txHash : null;
  const txHash = explicit ?? (await checkoutSubmittedHash(intent.id));
  if (!txHash) return apiError("invalid_request", "No transaction hash to verify.", undefined, "txHash");

  if (intent.authorizedParams && intent.authorizedParams !== canonicalParams(intent)) {
    return apiError("conflict", "The payment parameters changed after authorization.");
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
    return apiOk({
      verdict: check.verdict,
      phase: checkoutPhase(checkout, finalState),
      status: checkoutStatus(checkout, finalState),
      delivered: check.delivered,
      blockNumber: check.blockNumber,
    });
  }

  if (check.verdict === "reverted" || check.verdict === "short") {
    const finalState = await recordCheckoutFailure(checkout, intent, `${check.verdict}: ${check.message}`);
    return apiOk({ verdict: check.verdict, phase: checkoutPhase(checkout, finalState), status: checkoutStatus(checkout, finalState), message: check.message });
  }

  return apiOk({ verdict: check.verdict, phase: checkoutPhase(checkout, state), status: checkoutStatus(checkout, state), retryable: true, message: check.message });
}
