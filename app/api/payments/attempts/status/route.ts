import { NextResponse } from "next/server";
import { sessionFromRequest } from "@/lib/server/sessionRequest";
import { getAttempt, updateAttempt, recordFailure } from "@/lib/server/paymentAttempts";
import type { PaymentAttemptStatus } from "@/lib/store/types";
import { isValidTxHash } from "@/lib/server/referral/verify";
import { rateLimit, clientIp, tooManyResponse } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/attempts/status — advance an attempt's stage.
 *
 * The client reports what it observed at each stage; the server maps it to a
 * canonical status and a taxonomy category. A raw provider error is never stored
 * verbatim beyond a redacted diagnostic, and a rejection is never recorded as a
 * blockchain failure (no transaction was submitted).
 *
 * Authorization: when a verified session exists it must match the attempt's
 * account. Attempts with no account are only mutable while unauthenticated, so a
 * signed-in caller cannot rewrite another wallet's attempt.
 */
const EVENT_TO_STATUS: Record<string, PaymentAttemptStatus> = {
  prepared: "prepared",
  ready: "prepared",
  signing: "signing",
  submitted: "submitted",
  pending: "submitted",
  confirmed: "confirmed",
  succeeded: "confirmed",
  reverted: "failed",
  failed: "failed",
  rejected: "rejected",
  unknown: "unknown",
};

const FAILURE_SOURCE: Record<string, "readiness" | "quote" | "guard" | "execution" | "wallet" | "aa" | "generic"> = {
  prepared: "generic",
  signing: "guard",
  submitted: "execution",
  confirmed: "execution",
  reverted: "execution",
  failed: "execution",
  rejected: "wallet",
  unknown: "execution",
};

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const id = typeof body?.id === "string" ? body.id : "";
  const event = typeof body?.event === "string" ? body.event.toLowerCase() : "";
  if (!id || !EVENT_TO_STATUS[event]) {
    return NextResponse.json({ ok: false, message: "A valid attempt id and event are required." }, { status: 400 });
  }

  const attempt = getAttempt(id);
  if (!attempt) {
    return NextResponse.json({ ok: false, message: "Unknown attempt." }, { status: 404 });
  }

  const session = sessionFromRequest(req);
  if (attempt.account) {
    if (!session || session.address !== attempt.account) {
      return NextResponse.json({ ok: false, message: "Not authorized for this attempt." }, { status: 403 });
    }
  }

  const limited = rateLimit({ bucket: "attempt_status", subject: session?.address ?? clientIp(req), limit: 120, windowMs: 60_000 });
  if (!limited.ok) {
    const { body: b, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(b, { status: 429, headers });
  }

  const txHash = typeof body?.txHash === "string" && isValidTxHash(body.txHash) ? body.txHash : undefined;
  const userOpHash = typeof body?.userOpHash === "string" && /^0x[a-fA-F0-9]{64}$/.test(body.userOpHash) ? body.userOpHash : undefined;

  if (event === "reverted" || event === "failed" || event === "unknown" || event === "rejected") {
    const { category, mayHaveSubmitted } = recordFailure(
      id,
      typeof body?.code === "string" ? body.code : event,
      FAILURE_SOURCE[event] ?? "generic",
      typeof body?.diagnostic === "string" ? body.diagnostic : undefined,
    );
    if (txHash) updateAttempt(id, { txHash });
    if (userOpHash) updateAttempt(id, { userOpHash });
    return NextResponse.json({ ok: true, status: getAttempt(id)?.status, category, mayHaveSubmitted });
  }

  const status = EVENT_TO_STATUS[event];
  const patch: Parameters<typeof updateAttempt>[1] = { status };
  if (txHash) patch.txHash = txHash;
  if (userOpHash) patch.userOpHash = userOpHash;
  if (event === "confirmed") {
    patch.receiptStatus = "success";
    patch.lastVerifiedAt = Date.now();
  }
  const updated = updateAttempt(id, patch);
  return NextResponse.json({ ok: true, status: updated?.status ?? status });
}
