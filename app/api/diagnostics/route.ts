import { NextResponse } from "next/server";
import {
  alchemyStatus,
  alchemyBundlerStatus,
  alchemyPaymasterStatus,
  alchemyPricingStatus,
  zerionStatus,
} from "@/lib/server/diagnostics";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";

export const dynamic = "force-dynamic";

/**
 * GET /api/diagnostics — live integration health for operators.
 *
 * Reports configuration *and* reachability for every external provider, with
 * masked key suffixes so a deploy can be matched to a Vercel variable without
 * ever exposing a secret. Safe to leave enabled: it returns no key material and
 * performs only read-only probes.
 */
export async function GET() {
  const network: MonadNetwork = "mainnet";
  const [alchemy, bundler, paymaster, pricing, zerion] = await Promise.all([
    alchemyStatus(network),
    alchemyBundlerStatus(),
    alchemyPaymasterStatus(),
    alchemyPricingStatus(network),
    zerionStatus(),
  ]);

  const env = {
    ALCHEMY_API_KEY: Boolean(process.env.ALCHEMY_API_KEY),
    ALCHEMY_GAS_POLICY_ID: Boolean(process.env.ALCHEMY_GAS_POLICY_ID),
    ZERION_API_KEY: Boolean(process.env.ZERION_API_KEY),
    ZERION_ENABLED: process.env.ZERION_ENABLED ?? null,
    NEXT_PUBLIC_ALCHEMY_API_KEY: Boolean(process.env.NEXT_PUBLIC_ALCHEMY_API_KEY),
    MONAD_RPC_URL: Boolean(process.env.MONAD_RPC_URL),
    INTENT_LLM_API_KEY: Boolean(
      process.env.INTENT_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY,
    ),
  };

  return NextResponse.json({
    ok: true,
    network,
    chainId: NETWORKS[network].chainId,
    env,
    integrations: {
      alchemy: { ...alchemy, role: "RPC" },
      alchemyBundler: { ...bundler, role: "ERC-4337 Bundler" },
      alchemyPaymaster: { ...paymaster, role: "Gas Manager (Paymaster)" },
      alchemyPricing: { ...pricing, role: "Market prices" },
      zerion: { ...zerion, role: "Wallet intelligence" },
    },
  });
}
