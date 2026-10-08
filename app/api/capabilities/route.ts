import { NextResponse } from "next/server";
import { gasCapabilities } from "@/lib/server/gasCapabilities";
import { alchemyStatus, alchemyBundlerStatus, alchemyPaymasterStatus, zerionStatus } from "@/lib/server/diagnostics";
import { zerionEnabled } from "@/lib/server/zerion";
import { resolveMevProtection } from "@/lib/domain/protection";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";
import { getPaymasterProvider, paymasterChainId, paymasterConfigured } from "@/lib/server/paymaster";
import { normalizeSupportedTokens, gasTokenConfig } from "@/lib/server/paymaster/capabilities";

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
 * unreachable" instead of the misleading "add an API key". Wallet abstraction
 * is only `available` when a paymaster policy is genuinely usable — a bare key
 * or policy id is not enough.
 */
export async function GET() {
  const network: MonadNetwork = "mainnet";
  const gas = gasCapabilities(network);
  const mev = resolveMevProtection();
  const [alchemy, bundler, paymaster, zerion] = await Promise.all([
    alchemyStatus(network),
    alchemyBundlerStatus(),
    alchemyPaymasterStatus(),
    zerionStatus(),
  ]);

  // ERC-20 gas provider (Pimlico). Kept separate from Alchemy: Alchemy provides
  // RPC/Bundler/price infrastructure, Pimlico provides the ERC-20 paymaster. The
  // capability UI must name the provider that actually settles gas-in-token, so
  // the two are never conflated.
  const chainId = paymasterChainId();
  const erc20Provider = getPaymasterProvider();
  let erc20Configured = paymasterConfigured();
  let erc20Reachable = false;
  let erc20Error: string | null = null;
  let erc20SupportedTokens: { address: string; symbol: string; name: string; decimals: number }[] = [];
  if (erc20Provider && erc20Configured) {
    const [health, discovery] = await Promise.all([
      erc20Provider.reachable(chainId),
      erc20Provider.supportedTokens(chainId),
    ]);
    erc20Reachable = health.reachable;
    erc20Error = health.error ?? null;
    const normalized = normalizeSupportedTokens(discovery, chainId);
    if (normalized.ok) {
      erc20SupportedTokens = normalized.tokens.map((t) => {
        const c = gasTokenConfig(t);
        return { address: c.address, symbol: c.symbol, name: c.name, decimals: c.decimals };
      });
    } else if (!erc20Error) {
      erc20Error = normalized.reason ?? null;
    }
  }
  const erc20GasAvailable = erc20Configured && erc20Reachable;

  // A wallet-abstraction path exists only when the node+Bundler answer and a
  // usable Gas Manager policy is configured. A configured-but-unusable policy
  // reports a specific reason rather than a bare "unavailable".
  const bundlerOk = bundler.reachable;
  const paymasterUsable =
    paymaster.reachable && (paymaster.policyValid ?? true) && gas.sponsorshipConfigured;
  const abstractionAvailable = alchemy.reachable && bundlerOk && paymasterUsable;


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
      rpc: gas.rpc,
      alchemy: gas.alchemy,
      /** A key is present (may still be unreachable). */
      alchemyConfigured: alchemy.configured,
      /** The Alchemy node answered on Monad. */
      alchemyReachable: alchemy.reachable,
      alchemyError: alchemy.error,
      /** ERC-4337 Bundler reachability. */
      bundlerConfigured: bundler.configured,
      bundlerReachable: bundler.reachable,
      bundlerError: bundler.error,
      /** Gas Manager (paymaster) configuration + reachability. */
      paymasterConfigured: gas.policyConfigured,
      paymasterReachable: paymaster.reachable,
      paymasterPolicyValid: paymaster.policyValid,
      paymasterError: paymaster.error,
      policyStatus: gas.policyStatus,
      policyReason: gas.policyReason,
      /** An in-window policy is configured (sponsorship possible). */
      sponsorshipConfigured: gas.sponsorshipConfigured,
      erc20GasConfigured: gas.erc20GasConfigured,
      /** Addresses the configured paymaster sponsors (empty = unknown). */
      supportedTokens: gas.supportedTokens,
      policyId: gas.policyId,
    },
    /**
     * ERC-20 gas payment provider (the one that lets a user with 0 MON pay the
     * network fee in a token they hold). Distinct from Alchemy's sponsorship.
     * `supportedTokens` is discovered live from the provider — never hardcoded —
     * and is empty when discovery failed, so no token is ever overclaimed.
     */
    gasPayment: {
      provider: erc20Provider?.id ?? null,
      chainId,
      configured: erc20Configured,
      reachable: erc20Reachable,
      available: erc20GasAvailable,
      error: erc20Error,
      /** Tokens the provider currently accepts for gas on this chain. */
      supportedTokens: erc20SupportedTokens,
    },
    walletAbstraction: {
      available: abstractionAvailable,
      reason: abstractionAvailable
        ? null
        : !gas.alchemy
          ? "ALCHEMY_API_KEY is not set"
          : !alchemy.reachable
            ? `Alchemy node unreachable: ${alchemy.error ?? "unknown error"}`
            : !bundlerOk
              ? `Bundler unreachable: ${bundler.error ?? "unknown error"}`
              : !gas.policyConfigured
                ? "No Alchemy Gas Manager policy is configured (ALCHEMY_GAS_POLICY_ID)"
                : gas.policyStatus === "expired"
                  ? "The configured gas policy window has ended."
                  : !paymasterUsable
                    ? `Gas Manager not usable: ${paymaster.error ?? gas.policyReason ?? "unknown"}`
                    : null,
    },
  });
}
