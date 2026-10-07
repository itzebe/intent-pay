"use client";

import type { Address, Hash } from "viem";

/**
 * Alchemy execution capabilities (EIP-5792 wallet call API).
 *
 * Gas abstraction on Monad is delivered through the *wallet's own* ERC-4337 /
 * EIP-5792 stack. Monad supports EIP-7702 and has EntryPoint v0.6/v0.7/v0.8
 * deployed, and Alchemy operates a Bundler + Gas Manager (paymaster) there, but
 * the smart account lives inside the user's wallet. Intent Pay therefore asks
 * the wallet (via `wallet_getCapabilities`) whether it can batch and use a
 * paymaster; when it can, the payment's steps are submitted as one atomic batch
 * and gas is sponsored by the configured Alchemy gas policy — communicated to
 * the wallet as an ERC-7677 paymaster *service URL* (the correct EIP-5792 shape;
 * a bare policy id is not, and is silently ignored).
 *
 * When the wallet does not advertise the capability — e.g. MetaMask does not
 * expose `eth_signAuthorization`, so a dapp cannot force a 7702 upgrade — gas
 * is paid in MON and the app says so. That is the honest, real fallback; there
 * is no faked sponsorship.
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
  address?: Address,
): Promise<WalletCapabilities> {
  if (!provider?.request) return EMPTY_CAPS;
  try {
    const chainHex = "0x" + chainId.toString(16);
    const res = (await provider.request({
      method: "wallet_getCapabilities",
      // EIP-5792: [address?, [chainIds]] — some wallets require the address.
      params: [address, [chainHex]],
    })) as Record<string, any> | undefined;
    if (!res || typeof res !== "object") return EMPTY_CAPS;
    const caps = res[chainHex] ?? res[chainId.toString()] ?? {};
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
  /**
   * ERC-7677 paymaster service URL. The wallet calls this to obtain paymaster
   * fields; it is the *correct* shape for the EIP-5792 `paymasterService`
   * capability (a bare policy id is not, and is silently ignored by wallets).
   */
  paymasterServiceUrl?: string;
  /** ERC-7677 paymaster context (e.g. an Alchemy gas policy id). */
  paymasterContext?: Record<string, unknown>;
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
  if (opts.paymasterServiceUrl) {
    capabilities.paymasterService = {
      url: opts.paymasterServiceUrl,
      ...(opts.paymasterContext ? { context: opts.paymasterContext } : {}),
      // Marked optional so a wallet without paymaster support still processes
      // the calls (ERC-7677) rather than rejecting the whole batch.
      optional: true,
    };
  }
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

/** Alchemy chain slug for the ERC-7677 paymaster service URL. */
export const ALCHEMY_MONAD_SLUG = "monad-mainnet";

/**
 * The ERC-7677 paymaster service URL for Alchemy Gas Manager on Monad.
 *
 * This is what an EIP-5792 wallet is handed (via the `paymasterService`
 * capability) so it can request sponsored or ERC-20 gas fields. The key is a
 * public Alchemy key, safe to expose to the wallet.
 */
export function alchemyPaymasterServiceUrl(apiKey: string): string {
  return `https://${ALCHEMY_MONAD_SLUG}.g.alchemy.com/v2/${apiKey}`;
}

export type GasMode = "sponsored" | "erc20" | "native";

/**
 * Decide how gas will actually be paid for this payment.
 *
 * The distinction that matters for the "0 MON" case:
 *  - `sponsored` — a paymaster service is configured AND the wallet advertises
 *    the capability, so the user pays no MON at all.
 *  - `erc20`     — the wallet advertises ERC-20 gas payment but no paymaster is
 *    configured; the wallet may still charge gas in a token it supports.
 *  - `native`    — gas is paid in MON. This is the honest fallback.
 *
 * `walletSupportsPaymaster` is the result of the live `wallet_getCapabilities`
 * probe; `paymasterConfigured` is the server's Alchemy gas-policy status.
 */
export function resolveGasMode(
  paymasterConfigured: boolean,
  walletSupportsPaymaster: boolean,
  walletSupportsErc20Gas: boolean,
): GasMode {
  if (paymasterConfigured && walletSupportsPaymaster) return "sponsored";
  if (walletSupportsErc20Gas) return "erc20";
  return "native";
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
