import type { MonadNetwork } from "@/lib/config/chains";

/**
 * Alchemy execution capabilities, resolved server-side.
 *
 * Alchemy serves Monad Mainnet and supports an ERC-4337 Bundler, Gas Manager
 * (paymaster) and ERC-20 gas payments there. Whether a *specific payment* can
 * use them additionally depends on the user's wallet advertising the EIP-5792
 * `paymasterService` capability (checked in the browser, see
 * `lib/execution/alchemy.ts`). This module only reports what is configured and
 * reachable; it never claims sponsorship that isn't set up.
 *
 * A bare policy id is not enough to claim sponsorship. A policy can be past its
 * window and still be *configured*, in which case a UserOperation would be
 * rejected on-chain. We therefore resolve an explicit policy *status* from the
 * optional window variables so an expired policy is reported as expired — not
 * as "active" — and the UI never promises sponsored gas it will not get.
 */
export type PolicyStatus = "active" | "expired" | "not_yet_active" | "unknown";

export type GasCapabilities = {
  /** An Alchemy API key is configured (RPC / node / bundler features). */
  alchemy: boolean;
  /** A gas policy id is present (may still be expired — see `policyStatus`). */
  policyConfigured: boolean;
  /** The policy is present and currently within its window. */
  policyStatus: PolicyStatus;
  /** Human-readable reason when the policy is not usable. */
  policyReason?: string;
  /** Sponsorship is genuinely available right now (key + in-window policy). */
  sponsorshipConfigured: boolean;
  /** ERC-20 gas payment is configured (in-window policy + a supported token set). */
  erc20GasConfigured: boolean;
  /** The gas policy id, when configured. Safe to hand to a wallet capability. */
  policyId?: string;
  /**
   * Addresses the configured paymaster will sponsor. Empty means the set is
   * unknown, which the abstraction layer treats as "not sponsored" rather than
   * as "any token" — we never claim a token we cannot prove is covered.
   */
  supportedTokens: string[];
  /** RPC is currently routed through Alchemy. */
  rpc: "alchemy" | "public";
};

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

/**
 * Resolve the sponsorship policy window, when the deployment declares it.
 * `startTimeUnix` / `endTimeUnix` are the same fields the Alchemy Gas Manager
 * Admin API uses, so an operator can mirror the policy window into the
 * environment and the app will stop advertising an expired policy.
 */
export function resolvePolicyStatus(
  policyId: string | undefined,
  nowUnix = Math.floor(Date.now() / 1000),
): { status: PolicyStatus; reason?: string } {
  if (!policyId) return { status: "unknown" };
  const start = envInt("ALCHEMY_GAS_POLICY_START_UNIX");
  const end = envInt("ALCHEMY_GAS_POLICY_END_UNIX");
  if (end !== undefined && nowUnix >= end) {
    return { status: "expired", reason: "The configured gas policy window has ended." };
  }
  if (start !== undefined && nowUnix < start) {
    return { status: "not_yet_active", reason: "The configured gas policy has not started yet." };
  }
  return { status: "active" };
}

export function gasCapabilities(_network: MonadNetwork = "mainnet"): GasCapabilities {
  const alchemy = Boolean(process.env.ALCHEMY_API_KEY);
  const policyId = process.env.ALCHEMY_GAS_POLICY_ID || undefined;
  const { status: policyStatus, reason: policyReason } = resolvePolicyStatus(policyId);
  const inWindow = policyStatus === "active";
  const sponsorshipConfigured = alchemy && inWindow;
  const supportedTokens = envList("ALCHEMY_PAYMASTER_TOKENS");
  return {
    alchemy,
    policyConfigured: Boolean(policyId),
    policyStatus,
    policyReason,
    sponsorshipConfigured,
    // ERC-20 gas payment and sponsorship share the same Gas Manager policy; it
    // is only *usable per token* when the supported set is known.
    erc20GasConfigured: sponsorshipConfigured && supportedTokens.length > 0,
    policyId,
    supportedTokens,
    rpc: alchemy ? "alchemy" : "public",
  };
}

/**
 * Whether the user can have the network cost sponsored rather than paid in MON.
 * True only when sponsorship is configured *and* the wallet advertises the
 * capability (the client ANDs this with `wallet_getCapabilities`).
 */
export function canAbstractGas(network: MonadNetwork = "mainnet"): boolean {
  return gasCapabilities(network).sponsorshipConfigured;
}
