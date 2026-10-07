import { NextResponse } from "next/server";
import { gasCapabilities } from "@/lib/server/gasCapabilities";
import { zerionEnabled } from "@/lib/server/zerion";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";

export const dynamic = "force-dynamic";

/**
 * GET /api/capabilities — what infrastructure is actually configured.
 *
 * This is the honesty surface: the UI uses it to label the routing provider,
 * show whether gas can be sponsored / paid in an ERC-20, and whether Zerion is
 * contributing wallet intelligence. It reports configuration, never a claim
 * that a specific payment *will* be sponsored (that also needs a capable wallet).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const network: MonadNetwork = url.searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
  const gas = gasCapabilities(network);

  return NextResponse.json({
    ok: true,
    network,
    chainId: NETWORKS[network].chainId,
    routing: { provider: "uniswap-v3", chain: "monad", live: true },
    pricing: {
      primary: gas.alchemy ? "alchemy" : null,
      fallbacks: ["geckoterminal", "dexscreener", "onchain-dex"],
    },
    wallet: { zerion: zerionEnabled() },
    gas: {
      rpc: gas.rpc,
      alchemy: gas.alchemy,
      sponsorshipConfigured: gas.sponsorshipConfigured,
      // ERC-20 gas payment uses the same Alchemy gas policy + an EIP-5792 wallet.
      erc20GasConfigured: gas.sponsorshipConfigured,
      policyId: gas.policyId,
    },
  });
}
