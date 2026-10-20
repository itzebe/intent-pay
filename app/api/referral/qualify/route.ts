import { NextResponse } from "next/server";
import { sessionFromRequest } from "@/lib/server/sessionRequest";
import { qualify } from "@/lib/server/referral";
import { verifyQualifyingTransaction, isValidTxHash } from "@/lib/server/referral/verify";
import { rateLimit, tooManyResponse } from "@/lib/server/rateLimit";
import { recordOpsEvent } from "@/lib/server/ops";
import { requireDurableStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/referral/qualify — try to qualify the caller's referral from a
 * transaction hash.
 *
 * The referred wallet is the VERIFIED session address; the hash is untrusted and
 * verified server-side against Monad RPC. The result is never a client claim:
 *   - verified payment → `qualified`
 *   - provider unavailable / tx not yet mined → `pending_verification`
 *   - definitive failure (reverted, not the payer, no transfer, wrong chain) →
 *     `rejected`
 *
 * Repeated calls are idempotent; the same transaction cannot qualify two
 * referrals (enforced by a unique database constraint).
 *
 * Durability: a qualification that cannot be remembered is refused (503) rather
 * than reported as success.
 */
export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ ok: false, code: "unauthenticated", message: "Sign in with your wallet first." }, { status: 401 });
  }
  const durable = await requireDurableStore();
  if (!durable.ok) {
    return NextResponse.json(
      { ok: false, code: "storage_unavailable", durable: false, message: durable.reason },
      { status: 503 },
    );
  }
  const limited = await rateLimit({ bucket: "referral_qualify", subject: session.address, limit: 10, windowMs: 60_000 });
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const txHash = typeof body?.txHash === "string" ? body.txHash : "";
  if (!isValidTxHash(txHash)) {
    return NextResponse.json({ ok: false, code: "invalid_hash", message: "That isn't a valid transaction hash." }, { status: 400 });
  }

  const result = await qualify({
    referred: session.address,
    txHash,
    verifier: verifyQualifyingTransaction,
  });

  if (!result.ok) {
    const pending = result.code === "not_attributed";
    await recordOpsEvent({
      category: pending ? "transaction_status_unknown" : "invalid_instructions",
      service: "api/referral/qualify",
      message: result.message,
      severity: "info",
      unresolved: pending,
    });
    return NextResponse.json(
      { ok: false, code: result.code, message: result.message, state: pending ? "pending_verification" : "rejected" },
      { status: 200 },
    );
  }

  return NextResponse.json({ ok: true, state: result.value.state, qualifiedAt: result.value.qualifiedAt });
}
