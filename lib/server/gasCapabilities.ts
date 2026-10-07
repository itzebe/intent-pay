import type { MonadNetwork } from "@/lib/config/chains";

/**
 * Alchemy execution capabilities, resolved server-side.
 *
 * Alchemy serves Monad mainnet/testnet and supports Bundler, Gas Sponsorship and
 * ERC-20 gas payments there. Whether a *specific payment* can use them also
 * depends on the user's wallet advertising the EIP-5792 `paymasterService`
 * capability (checked in the browser). This module only reports what is
 * configured and reachable; it never claims sponsorship that isn't set up.
 */
export type GasCapabilities = {
  /** An Alchemy API key is configured (RPC / node features). */
  alchemy: boolean;
  /** An Alchemy gas policy is configured (sponsorship / ERC-20 gas possible). */
  sponsorshipConfigured: boolean;
  /** The gas policy id, when configured. Safe to hand to a wallet capability. */
  policyId?: string;
  /** RPC is currently routed through Alchemy. */
  rpc: "alchemy" | "public";
};

export function gasCapabilities(network: MonadNetwork = "mainnet"): GasCapabilities {
  const alchemy = Boolean(process.env.ALCHEMY_API_KEY);
  const policyId = process.env.ALCHEMY_GAS_POLICY_ID;
  return {
    alchemy,
    sponsorshipConfigured: alchemy && Boolean(policyId),
    policyId: policyId || undefined,
    rpc: alchemy ? "alchemy" : "public",
  };
}

/**
 * Whether the user can pay the network cost in an ERC-20 rather than MON.
 * True only when sponsorship is configured *and* the wallet advertises the
 * capability (the client ANDs this with `wallet_getCapabilities`).
 */
export function canAbstractGas(network: MonadNetwork = "mainnet"): boolean {
  return gasCapabilities(network).sponsorshipConfigured;
}
