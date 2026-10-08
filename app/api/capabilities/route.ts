import { NextResponse } from "next/server";
import { gasCapabilities } from "@/lib/server/gasCapabilities";
import { alchemyStatus, zerionStatus } from "@/lib/server/diagnostics";
import { zerionEnabled } from "@/lib/server/zerion";
import { resolveMevProtection } from "@/lib/domain/protection";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";

export const dynamic = "force-dynamic";

/**
 * GET /api/capabilities — what infrastructure is actually configured *and*
 * reachable.
 *
 * This is the honesty surface: the UI uses it to label the routing provider,
 * show whether gas can be sponsored / paid in an ERC-20, and whether Zerion is
 * contributing wallet intelligence.
 *
 * Configuration is not the same as working. `configured` says a key is present;
 * `reachable` says the provider answered a real request on Monad. The two are
 * reported separately so a misconfigured key reads as "configured but
 * unreachable" instead of the misleading "add an API key".
 */
export async function GET() {
  const network: MonadNetwork = "mainnet";
  const gas = gasCapabilities(network);
  const mev = resolveMevProtection();
  const [alchemy, zerion] = await Promise.all([alchemyStatus(network), zerionStatus()]);

  return NextResponse.json({
    ok: true,
    network,
    chainId: NETWORKS[network].chainId,
    routing: { provider: "uniswap-v3", chain: "monad", live: true },
    // Honest MEV / private-order-flow capability. `active` is true only when a
    // private submission endpoint is actually configured; otherwise the app
    // relies on on-chain slippage bounds, the price-impact guard and delivery
    // verification. Never a cosmetic badge.
    mevProtection: {
      state: mev.state,
      active: mev.active,
      privateRpcConfigured: mev.rpcConfigured,
      reason: mev.reason,
    },
    pricing: {
      primary: gas.alchemy ? "alchemy" : null,
      fallbacks: ["geckoterminal", "dexscreener", "onchain-dex"],
    },
    wallet: {
      zerion: zerionEnabled(),
      zerionConfigured: zerion.configured,
      zerionReachable: zerion.reachable,
      zerionError: zerion.error,
    },
    gas: {
      rpc: gas.rpc,
      alchemy: gas.alchemy,
      /** A key is present (may still be unreachable). */
      alchemyConfigured: alchemy.configured,
      /** The Alchemy node answered on Monad. */
      alchemyReachable: alchemy.reachable,
      alchemyError: alchemy.error,
      sponsorshipConfigured: gas.sponsorshipConfigured,
      // ERC-20 gas payment uses the same Alchemy gas policy + an EIP-5792 wallet.
      erc20GasConfigured: gas.sponsorshipConfigured,
      policyId: gas.policyId,
    },
  });
}
