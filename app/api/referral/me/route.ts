import { NextResponse } from "next/server";
import { sessionFromRequest } from "@/lib/server/sessionRequest";
import { getOrCreateCode, dashboardFor } from "@/lib/server/referral";
import { referralOrigin } from "@/lib/config/referral";
import { referralUrl } from "@/lib/domain/referralCode";
import { requireDurableStore, storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/referral/me — the caller's own referral code, link, and dashboard.
 *
 * Identity comes exclusively from the verified session cookie; there is no
 * `address` query parameter, so one user cannot read another's dashboard by
 * changing a value. Creating a code is idempotent — the same code is returned
 * across sessions.
 *
 * Durability: when the store is not durable this endpoint refuses (503) rather
 * than issuing a code that will not be remembered, and never reports a
 * persistent referral link it cannot honour. The `durable` flag is included on
 * every response so the UI can be explicit about persistence.
 */
export async function GET(req: Request) {
  const session = await sessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { ok: false, code: "unauthenticated", message: "Sign in with your wallet to view referrals." },
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
  const created = await getOrCreateCode(session.address);
  if (!created.ok) {
    return NextResponse.json({ ok: false, code: created.code, message: created.message }, { status: 400 });
  }
  const origin = referralOrigin();
  const dash = await dashboardFor(session.address, (code) => referralUrl(origin, code));
  if (!dash.ok) {
    return NextResponse.json({ ok: false, code: dash.code, message: dash.message }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    durable: (await storeCapability()).durable,
    address: session.address,
    code: dash.value.code,
    url: dash.value.url,
    counts: dash.value.counts,
    referrals: dash.value.referrals,
    /** Attribution is first-touch within this window. */
    attributionWindowDays: Math.round((30 * 24 * 60 * 60 * 1000) / 86_400_000),
  });
}
