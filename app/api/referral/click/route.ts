import { NextResponse } from "next/server";
import { recordClick } from "@/lib/server/referral";
import { rateLimit, clientFingerprint } from "@/lib/server/rateLimit";
import { normalizeCode } from "@/lib/domain/referralCode";

export const dynamic = "force-dynamic";

/**
 * POST /api/referral/click — record a referral-link visit.
 *
 * A click is NOT a successful referral: it only proves a link was opened. It is
 * deduplicated per (code + client fingerprint + day) at the database level, so a
 * refresh cannot inflate the count. Rate limited per client fingerprint.
 *
 * No wallet address is involved (the visitor may not be connected yet).
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }
  const code = normalizeCode(typeof body?.code === "string" ? body.code : "");
  if (!code) {
    return NextResponse.json({ ok: false, code: "invalid_code", message: "That referral code isn't valid." }, { status: 400 });
  }
  const fingerprint = clientFingerprint(req);
  const limited = rateLimit({ bucket: "referral_click", subject: fingerprint, limit: 60, windowMs: 60_000 });
  if (!limited.ok) return tooMany(limited.resetAt);

  const result = recordClick({ code, fingerprint });
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, code, deduped: result.value.deduped });
}

function tooMany(resetAt: number) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { ok: false, message: "Too many requests. Please wait and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
