import { NextResponse } from "next/server";
import { normalizeCode } from "@/lib/domain/referralCode";
import { getStore } from "@/lib/store";
import { rateLimit, clientFingerprint, tooManyResponse } from "@/lib/server/rateLimit";

export const dynamic = "force-dynamic";

/**
 * GET /api/referral/validate?code=INTENT-XXXXXX — is this code real?
 *
 * Returns only a boolean and the (public) code. It never reveals the referrer's
 * wallet address, so code validation cannot be used to enumerate referrers. Rate
 * limited per client fingerprint to blunt enumeration.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = normalizeCode(url.searchParams.get("code"));
  const fingerprint = clientFingerprint(req);
  const limited = await rateLimit({ bucket: "referral_validate", subject: fingerprint, limit: 60, windowMs: 60_000 });
  if (!limited.ok) {
    const { body, headers } = tooManyResponse(limited.resetAt);
    return NextResponse.json(body, { status: 429, headers });
  }
  if (!code) return NextResponse.json({ ok: true, valid: false });
  const row = await getStore().findOne("referralCodes", { code });
  return NextResponse.json({ ok: true, valid: Boolean(row), code: row ? code : null });
}
