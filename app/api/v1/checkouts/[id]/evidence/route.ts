import { apiError, apiOk, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { canonicalParams, checkoutSubmittedHash, currentState, getIntent, intentFingerprint } from "@/lib/developer/intents";
import { checkoutLifecycle, checkoutTxHashes, expireCheckoutIfStale, getCheckout, publicCheckout } from "@/lib/developer/checkouts";
import { settlementToleranceBps, verifySettlement } from "@/lib/developer/settlement";
import { intentClaim } from "@/lib/developer/claims";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/checkouts/:id/evidence — the merchant's settlement evidence.
 *
 * Returns everything a merchant needs to reconcile an order against the chain,
 * and **re-verifies** settlement live rather than trusting a stored flag:
 *
 *   - the checkout and its derived status,
 *   - the bound intent's frozen parameters and fingerprint,
 *   - the recorded transaction hash(es),
 *   - a fresh `verifySettlement` verdict (the authoritative on-chain check),
 *   - the durable transaction claim the order holds (the replay guard), if any,
 *   - the intent lifecycle history.
 *
 * The `settlement.verdict` is `verified` only when the recipient was actually
 * proven paid. If the chain cannot be reached it is `unavailable` — never a
 * false confirmation.
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
  const checkout = await getCheckout(auth.auth.developer.id, id);
  if (!checkout) return apiError("not_found", "No such checkout.", auth.requestId);

  const intent = await getIntent(auth.auth.developer.id, checkout.intentId);
  if (!intent) return apiError("not_found", "The bound intent no longer exists.", auth.requestId);

  await expireCheckoutIfStale(checkout);
  const state = await currentState(intent.id);
  const txHashes = await checkoutTxHashes(intent.id);
  const lifecycle = await checkoutLifecycle(intent.id);

  const txHash = (await checkoutSubmittedHash(intent.id)) ?? null;
  const settlement = txHash
    ? await verifySettlement({
        txHash,
        recipient: intent.recipient,
        receiveTokenAddress: intent.receiveTokenAddress,
        receiveToken: intent.receiveToken,
        expectedAmount: intent.amount,
        toleranceBps: settlementToleranceBps(intent.amountMode),
        notBeforeMs: intent.createdAt,
      })
    : null;

  const claim = await intentClaim(intent.id);

  const frozen = intent.authorizedParams ? (JSON.parse(intent.authorizedParams) as Record<string, unknown>) : null;
  const matchesFrozen = intent.authorizedParams === null || intent.authorizedParams === canonicalParams(intent);

  return apiOk({
    checkout: publicCheckout(checkout, state),
    intent: {
      id: intent.id,
      state,
      chainId: intent.chainId,
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveTokenAddress: intent.receiveTokenAddress,
      amountMode: intent.amountMode,
      amount: intent.amount,
      payToken: intent.payToken,
      reference: intent.reference,
      authorized: intent.authorizedParams !== null,
      /** True when the current parameters still match the frozen set. */
      frozenMatchesCurrent: matchesFrozen,
      fingerprint: intentFingerprint(intent),
    },
    authorizedParams: frozen,
    txHashes,
    lifecycle,
    settlement,
    /**
     * The durable claim this order holds on its transaction. Its presence is the
     * proof that the transaction is attributed to this order and cannot be
     * reused by another.
     */
    transactionClaim: claim
      ? { chainId: claim.chainId, txHash: claim.txHash, blockNumber: claim.blockNumber, delivered: claim.delivered, claimedAt: new Date(claim.claimedAt).toISOString() }
      : null,
    /** The honest bottom line: true only when the chain proves the payment. */
    settled: settlement?.verdict === "verified",
  });
}
