import { NextResponse } from "next/server";
import { sessionFromRequest } from "@/lib/server/sessionRequest";
import { attribute, markActivated, markRegistered, referralForReferred } from "@/lib/server/referral";
import { rateLimit, clientFingerprint, tooManyResponse } from "@/lib/server/rateLimit";
import { requireDurableStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/referral/attribute — establish attribution for the signed-in wallet.
 *
 * The referred identity is the VERIFIED session address, never a body field, so
 * a caller cannot attribute someone else's wallet. The code is untrusted input,
 * validated server-side. Attribution is first-touch and immutable; repeating the
 * request is idempotent. Self-referral is refused.
 *
 * A successful attribution also advances the lifecycle to `registered` (the
 * user has a wallet and an app session), which is a real, server-observed event
 * — not a claim.
 *
 * Durability: attribution is meaningless if it cannot be remembered. When the
 * store is not durable the request is refused (503) with an explicit reason
 * rather than reporting a success that would vanish on the next cold start.
 */
export async function POST(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { ok: false, code: "unauthenticated", message: "Sign in with your wallet first." },
      { status: 401 },
    );
  }
  const durable = await requireDurableStore();
  if (!durable.ok) {
    return NextResponse.json(
      { ok: false, code: "storage_unavailable", durable: false, message: durable.reason },
      { status: 503 },
    );
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  const fingerprint = clientFingerprint(req);
  const limited = await rateLimit({ bucket: "referral_attribute", subject: session.address, limit: 20, windowMs: 60_000 });
  if (!limited.ok) {
    const { body: b, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(b, { status: 429, headers });
  }

  const code = typeof body?.code === "string" ? body.code : "";
  const result = await attribute({ code, referred: session.address, fingerprint });
  if (!result.ok) {
    // "already attributed" is a benign, idempotent outcome: report the existing
    // state without leaking another user's data.
    const status = result.code === "invalid_code" || result.code === "invalid_address" ? 400 : 409;
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status });
  }
  await markRegistered(session.address);
  const current = await referralForReferred(session.address);
  return NextResponse.json({
    ok: true,
    state: current?.state ?? "attributed",
    referrer: result.value.referrer,
  });
}

/** POST /api/referral/activate — mark a defined activation event (idempotent). */
export async function PUT(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ ok: false, code: "unauthenticated", message: "Sign in with your wallet first." }, { status: 401 });
  }
  const limited = await rateLimit({ bucket: "referral_activate", subject: session.address, limit: 20, windowMs: 60_000 });
  if (!limited.ok) {
    const { body: b, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(b, { status: 429, headers });
  }
  const result = await markActivated(session.address);
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, state: result.value.state });
}
