import { NextResponse } from "next/server";
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
 * show whether wallet intelligence (Zerion) is contributing, and report the
 * configured market-price chain. Gas is always paid in MON by the standard EOA
 * execution path, so no sponsorship / account-abstraction capability is claimed
 * here.
 *
 * Configuration is not the same as working. `configured` says a key is present;
 * `reachable` says the provider answered a real request on Monad. The two are
 * reported separately so a misconfigured key reads as "configured but
 * unreachable" instead of the misleading "add an API key".
 */
export async function GET() {
  const network: MonadNetwork = "mainnet";
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
      primary: Boolean(process.env.ALCHEMY_API_KEY) ? "alchemy" : null,
      fallbacks: ["geckoterminal", "dexscreener", "onchain-dex"],
    },
    wallet: {
      zerion: zerionEnabled(),
      zerionConfigured: zerion.configured,
      zerionReachable: zerion.reachable,
      zerionError: zerion.error,
      /**
       * Zerion sub-capabilities. These are gated on the live reachability probe
       * (which validates the key against the Monad chain), not on the key alone:
       * the same HTTP auth that powers portfolio/positions/balances is what the
       * probe exercises, so a reachable Zerion serves all three.
       */
      portfolio: zerion.reachable,
      positions: zerion.reachable,
      balances: zerion.reachable,
    },
    gas: {
      /** The network fee is always paid in the native asset (MON). */
      mode: "native",
      rpc: Boolean(process.env.ALCHEMY_API_KEY) ? "alchemy" : "public",
      /** Alchemy provides RPC transport and market prices (not gas abstraction). */
      alchemy: Boolean(process.env.ALCHEMY_API_KEY),
      alchemyConfigured: alchemy.configured,
      alchemyReachable: alchemy.reachable,
      alchemyError: alchemy.error,
    },
  });
}
