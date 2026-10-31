import { NextResponse } from "next/server";
import { adminAuthorized, adminConfigured } from "@/lib/server/auth";
import { enforceRateLimit, ROUTE_LIMITS } from "@/lib/server/apiGuard";
import {
  alchemyStatus,
  alchemyPricingStatus,
  zerionStatus,
} from "@/lib/server/diagnostics";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";

export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics — live integration health for operators.
 *
 * Admin-only (`INTENT_PAY_ADMIN_TOKEN`), like the other ops surfaces. When the
 * token is unset the endpoint is *unavailable* (503), never open. It reveals
 * which providers are configured, the shape of the deployment environment and a
 * masked key suffix — a useful reconnaissance map for an attacker — so it must
 * not be world-readable. The public, honest capability surface for the UI is
 * `/api/capabilities`, which exposes reachability without key material or an
 * environment inventory.
 */
export async function GET(req: Request) {
  // Rate limit before authentication or any provider probe: the admin token is a
  // brute-force target, so bound attempts per client before doing any work.
  const limited = await enforceRateLimit(req, ROUTE_LIMITS.admin);
  if (limited) return limited;
  if (!adminConfigured()) {
    return NextResponse.json(
      { ok: false, code: "not_configured", message: "Diagnostics are not configured." },
      { status: 503 },
    );
  }
  if (!adminAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, message: "Not authorized." }, { status: 401 });
  }

  const network: MonadNetwork = "mainnet";
  const [alchemy, pricing, zerion] = await Promise.all([
    alchemyStatus(network),
    alchemyPricingStatus(network),
    zerionStatus(),
  ]);

  const env = {
    ALCHEMY_API_KEY: Boolean(process.env.ALCHEMY_API_KEY),
    ZERION_API_KEY: Boolean(process.env.ZERION_API_KEY),
    ZERION_ENABLED: process.env.ZERION_ENABLED ?? null,
    NEXT_PUBLIC_ALCHEMY_API_KEY: Boolean(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY),
    MONAD_RPC_URL: Boolean(process.env.MONAD_RPC_URL),
    INTENT_LLM_API_KEY: Boolean(
      process.env.INTENT_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY,
    ),
  };

  // Never emit a key suffix, even to an authenticated operator: it is an
  // unnecessary fragment of a live secret and the operator already controls the
  // deployment's environment.
  const strip = <T extends { keySuffix?: string }>(s: T): Omit<T, "keySuffix"> => {
    const { keySuffix: _omit, ...rest } = s;
    return rest;
  };

  return NextResponse.json({
    ok: true,
    network,
    chainId: NETWORKS[network].chainId,
    env,
    integrations: {
      alchemy: { ...strip(alchemy), role: "RPC" },
      alchemyPricing: { ...strip(pricing), role: "Market prices" },
      zerion: { ...strip(zerion), role: "Wallet intelligence" },
    },
  });
}
