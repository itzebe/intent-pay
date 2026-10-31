import { NextResponse } from "next/server";
import { enforceRateLimit, ROUTE_LIMITS } from "@/lib/server/apiGuard";
import { storeCapability } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/referral/availability — is durable referral attribution available?
 *
 * Public and unauthenticated on purpose: it lets the UI explain that referrals
 * are unavailable *before* asking the user to sign a message. It exposes only a
 * boolean capability (never a path, credential, or wallet), so it reveals
 * nothing sensitive. It does perform a real storage probe, so it is rate limited
 * per client to bound that amplification.
 */
export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, ROUTE_LIMITS.referralAvailability);
  if (limited) return limited;
  const storage = await storeCapability();
  return NextResponse.json({
    ok: true,
    durable: storage.durable,
    durability: storage.durability,
    reachable: storage.reachable,
    schemaReady: storage.schemaReady,
    referralAttribution: storage.durable ? "available" : "unavailable",
  });
}
