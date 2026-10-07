"use client";

import type { Address, Hash } from "viem";

/**
 * Alchemy execution capabilities (EIP-5792 wallet call API).
 *
 * Alchemy supports Monad for bundler / gas sponsorship / ERC-20 gas payment.
 * Rather than force a wallet migration, Intent Pay asks the *user's own* wallet
 * whether it supports the EIP-5792 `paymasterService` capability; when it does,
 * the payment's steps are submitted as one atomic batch and gas can be
 * sponsored by the configured Alchemy gas policy. When the wallet (or the
 * policy) is unavailable we fall back to normal MON gas — never a fake claim.
 *
 * Docs: https://www.alchemy.com/docs/wallets/transactions/sponsor-gas
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

export type SponsorshipConfig = {
  /** Alchemy key present and policy configured server-side. */
  configured: boolean;
  /** Gas policy id, safe to hand to the wallet's paymaster capability. */
  policyId?: string;
  /** True when the browser is also using Alchemy RPC. */
  alchemyRpc: boolean;
};

export type WalletCapabilities = {
  atomicBatch: boolean;
  paymasterService: boolean;
  /** The wallet can pay gas in an ERC-20 (EIP-5792 `erc20GasPayment`-style). */
  erc20GasPayment: boolean;
};

const EMPTY_CAPS: WalletCapabilities = {
  atomicBatch: false,
  paymasterService: false,
  erc20GasPayment: false,
};

/** Ask the wallet what it supports on this chain. Never throws. */
export async function getWalletCapabilities(
  provider: Eip1193 | undefined,
  chainId: number,
): Promise<WalletCapabilities> {
  if (!provider?.request) return EMPTY_CAPS;
  try {
    const res = (await provider.request({
      method: "wallet_getCapabilities",
      params: [undefined, ["0x" + chainId.toString(16)]],
    })) as Record<string, any> | undefined;
    if (!res || typeof res !== "object") return EMPTY_CAPS;
    const caps = res["0x" + chainId.toString(16)] ?? res[chainId.toString()] ?? {};
    const atomic = caps?.atomic?.status ?? caps?.atomic;
    return {
      atomicBatch: atomic === "supported" || atomic === "ready" || atomic === true,
      paymasterService: Boolean(caps?.paymasterService?.supported ?? caps?.paymasterService),
      erc20GasPayment: Boolean(caps?.erc20GasPayment?.supported ?? caps?.erc20GasPayment),
    };
  } catch {
    return EMPTY_CAPS;
  }
}

export type Call = { to: Address; data?: `0x${string}`; value?: bigint };

export type SendCallsOptions = {
  from: Address;
  chainId: number;
  calls: Call[];
  /** When set and the wallet supports it, gas is sponsored by this policy. */
  policyId?: string;
  /** Request ERC-20 gas payment instead of sponsorship, when supported. */
  erc20GasPayment?: boolean;
};

/**
 * Submit a batch of calls through the wallet (EIP-5792 `wallet_sendCalls`).
 * Returns the batch id used to poll status. Throws if the wallet rejects or
 * does not implement the method — the caller falls back to sequential txs.
 */
export async function sendCalls(
  provider: Eip1193,
  opts: SendCallsOptions,
): Promise<string> {
  const capabilities: Record<string, unknown> = {};
  if (opts.policyId) capabilities.paymasterService = { policyId: opts.policyId };
  if (opts.erc20GasPayment) capabilities.erc20GasPayment = { optional: true };

  const payload = {
    version: "2.0.0",
    from: opts.from,
    chainId: "0x" + opts.chainId.toString(16),
    atomicRequired: true,
    calls: opts.calls.map((c) => ({
      to: c.to,
      data: c.data,
      value: c.value !== undefined ? "0x" + c.value.toString(16) : undefined,
    })),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };

  const res = (await provider.request({
    method: "wallet_sendCalls",
    params: [payload],
  })) as { id?: string } | string | undefined;

  const id = typeof res === "string" ? res : res?.id;
  if (!id) throw new Error("The wallet did not return a call id.");
  return id;
}

export type CallsStatus = {
  status: "pending" | "confirmed" | "failed";
  hash?: Hash;
  receipts?: { transactionHash?: Hash; status?: string }[];
};

/** Poll `wallet_getCallsStatus` until the batch is confirmed or fails. */
export async function waitForCalls(
  provider: Eip1193,
  id: string,
  timeoutMs = 90_000,
  intervalMs = 1_500,
): Promise<CallsStatus> {
  const started = Date.now();
  let last: CallsStatus = { status: "pending" };
  while (Date.now() - started < timeoutMs) {
    try {
      const res = (await provider.request({
        method: "wallet_getCallsStatus",
        params: [id],
      })) as any;
      const code = res?.status ?? res?.statusCode;
      const receipts = res?.receipts as CallsStatus["receipts"];
      const hash: Hash | undefined =
        res?.receipts?.[0]?.transactionHash ?? res?.transactionHash ?? res?.hash;
      // EIP-5792 status codes: 200 = confirmed, 400/500 = failed.
      if (code === 200 || code === "CONFIRMED") {
        return { status: "confirmed", hash, receipts };
      }
      if (code === 400 || code === 500 || code === "FAILED") {
        return { status: "failed", hash, receipts };
      }
      last = { status: "pending", hash, receipts };
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
