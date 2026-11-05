import { NextResponse } from "next/server";
import { apiError, apiOk, readJson, requireDeveloper } from "@/lib/developer/apiAuth";
import { checkLimit, tooManyResponse } from "@/lib/developer/rateLimits";
import { canonicalParams, currentState, getIntent, intentEvents, submittedTxHashes, transition } from "@/lib/developer/intents";

import { checkTransactionSet, settlementToleranceBps } from "@/lib/developer/settlement";
import { claimTransaction } from "@/lib/developer/claims";
import { isValidTxHash } from "@/lib/server/referral/verify";
import { isTerminal } from "@/lib/developer/intentLifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/intents/:id/verify — independently verify settlement on-chain.
 *
 * Body: `{ txHash?: "0x…" }` (defaults to the hash recorded at submit).
 *
 * This reads the authoritative Monad receipt itself and proves the recipient
 * received the requested asset. The verdict is honest and specific:
 *   - `verified`  → the recipient received at least the authorized minimum;
 *   - `reverted`  → the transaction failed on-chain (intent → failed);
 *   - `short`     → the recipient received less than intended (intent → failed);
 *   - `historical`→ the transaction predates the order (intent → failed);
 *   - `pending` / `not_found` / `unavailable` / `unconfirmed` → the intent stays
 *     submitted and the caller is told to retry; nothing is falsely confirmed.
 *
 * Only a `verified` verdict advances the intent to `verified`, and only then is
 * a `payment.verified` webhook emitted (inside the transition). A transaction
 * already consumed by another intent is refused with `replay_detected`.
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
  const record = await getIntent(auth.auth.developer.id, id);
  if (!record) return apiError("not_found", "No such intent.", auth.requestId);

  const state = await currentState(record.id);
  if (state === "verified") {
    // Idempotent: an already-verified intent returns its verdict.
    const events = await intentEvents(record.id);
    return apiOk({ verdict: "verified", state, lifecycle: events.map((e) => ({ state: e.state, at: new Date(e.at).toISOString() })) });
  }
  if (isTerminal(state)) return apiError("invalid_state", `This intent is ${state}.`, auth.requestId);

  // A hash is required: the ones from submit, or an explicit one in the body.
  const body = await readJson(req);
  const explicit = typeof body?.txHash === "string" && isValidTxHash(body.txHash) ? body.txHash : null;
  // A swap payment is several transactions (approve → swap → deliver); the one
  // that pays the recipient is not necessarily the first. Verify across every
  // hash recorded at submit, unless the caller named one explicitly.
  const hashes = explicit ? [explicit] : await submittedTxHashes(record.id);
  if (hashes.length === 0) {
    return apiError("invalid_request", "No transaction hash to verify. Submit one, or pass `txHash`.", auth.requestId, "txHash");
  }

  if (record.authorizedParams && record.authorizedParams !== canonicalParams(record)) {
    return apiError("conflict", "The intent's parameters changed after authorization.", auth.requestId);
  }

  const check = await checkTransactionSet(hashes, {
    recipient: record.recipient,
    receiveTokenAddress: record.receiveTokenAddress,
    receiveToken: record.receiveToken,
    expectedAmount: record.amount,
    toleranceBps: settlementToleranceBps(record.amountMode),
    notBeforeMs: record.createdAt,
  });

  if (check.verdict === "verified") {
    // Claim the transaction that actually delivered; a hash already used by
    // another intent is a replay and is refused.
    const settledHash = check.txHash ?? hashes[0];
    const claim = await claimTransaction({
      chainId: record.chainId,
      txHash: settledHash,
      intentId: record.id,
      developerId: record.developerId,
      blockNumber: check.blockNumber,
      delivered: check.delivered,
    });
    if (!claim.ok) {
      return apiError("replay_detected", "This transaction has already been used to pay another intent.", auth.requestId, claim.claimedBy.intentId);
    }
    const current = await currentState(record.id);
    if (current === "submitted") await transition(record, "confirmed", `block:${check.blockNumber}`);
    const afterConfirm = await currentState(record.id);
    if (afterConfirm === "confirmed") await transition(record, "verified", `delivered:${check.delivered}`);
    const newState = await currentState(record.id);
    return apiOk({ verdict: check.verdict, state: newState, settlement: check });
  }

  if (check.verdict === "reverted" || check.verdict === "short" || check.verdict === "historical") {
    const current = await currentState(record.id);
    if (current === "submitted" || current === "confirmed") {
      await transition(record, "failed", `${check.verdict}: ${check.message}`.slice(0, 300));
    }
    const newState = await currentState(record.id);
    return apiOk({ verdict: check.verdict, state: newState, settlement: check });
  }

  // pending / not_found / unavailable / unconfirmed — the intent stays where it is.
  return apiOk({ verdict: check.verdict, state, settlement: check, retryable: true });
}

