import { NextResponse } from "next/server";
import { storeStatus } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/referral/availability — is durable referral attribution available?
 *
 * Public and unauthenticated on purpose: it lets the UI explain that referrals
 * are unavailable *before* asking the user to sign a message. It exposes only a
 * boolean capability (never a path, credential, or wallet), so it reveals
 * nothing sensitive.
 */
export async function GET() {
  const storage = storeStatus();
  return NextResponse.json({
    ok: true,
    durable: storage.durable,
    durability: storage.durability,
    referralAttribution: storage.durable ? "available" : "unavailable",
  });
}
