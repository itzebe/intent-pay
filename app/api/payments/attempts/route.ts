import { NextResponse } from "next/server";
import { sessionFromRequest } from "@/lib/server/sessionRequest";
import { createAttempt } from "@/lib/server/paymentAttempts";
import { rateLimit, clientIp, tooManyResponse } from "@/lib/server/rateLimit";
import { isEvmAddress } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * POST /api/payments/attempts — start a correlated payment attempt.
 *
 * The record stores no amounts, instructions, signatures, or secrets: only the
 * intent fingerprint, the (public) token symbols, the gas mode, and an optional
 * idempotency key. The account is taken from the verified session when present,
 * else from the request body (a wallet address is public information, so this is
 * a correlation hint, not an authorization).
 *
 * An idempotency key makes repeated preparation return the SAME attempt. This is
 * a server-side preparation guard only — it cannot prevent a wallet from
 * broadcasting a transaction, since the wallet signs and sends directly.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const session = sessionFromRequest(req);
  const bodyAccount = typeof body?.account === "string" && isEvmAddress(body.account) ? body.account : null;
  const account = session?.address ?? bodyAccount;

  const limited = rateLimit({ bucket: "payment_attempt", subject: session?.address ?? clientIp(req), limit: 60, windowMs: 60_000 });
  if (!limited.ok) {
    const { body: b, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(b, { status: 429, headers });
  }

  const idempotencyKey =
    typeof body?.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim().slice(0, 120)
      : null;

  const attempt = createAttempt({
    account,
    intentKey: typeof body?.intentKey === "string" ? body.intentKey.slice(0, 200) : null,
    receiveToken: typeof body?.receiveToken === "string" ? body.receiveToken.slice(0, 20) : null,
    payToken: typeof body?.payToken === "string" ? body.payToken.slice(0, 20) : null,
    gasMode: typeof body?.gasMode === "string" ? body.gasMode.slice(0, 20) : null,
    provider: typeof body?.provider === "string" ? body.provider.slice(0, 40) : null,
    idempotencyKey,
    diagnostic: typeof body?.diagnostic === "string" ? body.diagnostic : null,
  });

  return NextResponse.json({
    ok: true,
    id: attempt.id,
    status: attempt.status,
    createdAt: attempt.createdAt,
  });
}
