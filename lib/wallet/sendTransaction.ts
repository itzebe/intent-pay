"use client";

import type { Address, WalletClient } from "viem";
import { NETWORKS } from "@/lib/config/chains";
import { buildSendParams, type TxPreparation } from "@/lib/execution/prepareTx";

/**
 * Provider-agnostic transaction submission.
 *
 * Intent Pay prepares the calldata itself (`encodeStep`) from a plan it built
 * with its own RPC reads; the wallet's only job is to approve, sign and
 * broadcast. That job is exactly `eth_sendTransaction`, and it is the one method
 * every injected wallet — including Trust Wallet's in-app browser — answers
 * natively, without touching its own node.
 *
 * viem's high-level writers (`writeContract` / `sendTransaction`) do *not* stay
 * within that contract: they first assert the chain by calling `eth_chainId`
 * through the wallet provider, and they also ask the provider for
 * `eth_getTransactionCount` / `eth_estimateGas` when those fields are absent.
 * On Monad a Trust Wallet provider answers `eth_chainId` by proxying to its own
 * node (`monad.twnodes.com`); when that read is blocked or unreachable the
 * assertion throws and viem aborts **before** ever calling `eth_sendTransaction`
 * — the reported "Failed to connect to http://monad.twnodes.com/" dead end.
 *
 * Submitting the raw `eth_sendTransaction` with an explicit `chainId` param
 * avoids every one of those wallet reads: the transaction carries the chain
 * identity the app already validated, and the wallet broadcasts it through its
 * native path. The app still never sees a key and never signs on the user's
 * behalf — this only removes an unnecessary wallet RPC read.
 *
 * `prepared` (see `lib/execution/prepareTx`) additionally supplies `gas`, the
 * EIP-1559 fee fields and an optional `nonce`, all read by the app through its
 * own HTTPS Monad RPC. A wallet whose own node is unreachable (Trust Wallet's
 * in-app browser proxying to `monad.twnodes.com`) then has nothing left to
 * estimate or fetch before it can sign — the reported Confirm-and-Send failure.
 * A field the app could not read is omitted, never fabricated.
 *
 * The return value is deliberately a discriminated result rather than a bare
 * hash, so a caller can tell "the wallet rejected" (definite failure) from
 * "the wallet's transport failed after we asked it to send" (unknown — the
 * transaction may still be on-chain).
 */

export type WalletSendResult =
  | { ok: true; hash: `0x${string}` }
  | { ok: false; reason: "rejected"; error: unknown }
  | { ok: false; reason: "unsupported"; error: unknown }
  | { ok: false; reason: "send_failed"; error: unknown }
  | { ok: false; reason: "invalid_hash"; error?: unknown };

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** EIP-1193 user rejection. */
function isRejection(err: unknown): boolean {
  const code = (err as { code?: number } | undefined)?.code;
  if (code === 4001) return true;
  const msg = String((err as { message?: string } | undefined)?.message ?? "");
  return /user rejected|user denied|denied transaction|rejected the request/i.test(msg);
}

/** The wallet does not implement `eth_sendTransaction` (4200 / -32601). */
function isUnsupported(err: unknown): boolean {
  const code = (err as { code?: number } | undefined)?.code;
  return code === 4200 || code === -32601;
}

/**
 * Send one already-encoded call through the wallet, with the chain identity in
 * the request so the wallet never has to read its own `eth_chainId`.
 *
 * `value` is a bigint in wei (as `encodeStep` produces); it is hex-encoded for
 * the JSON-RPC param. An empty `data` is omitted rather than sent as `0x`, so a
 * plain native transfer is unambiguous.
 */
export async function sendTransactionViaWallet(
  walletClient: WalletClient,
  account: Address,
  call: { to: Address; data?: `0x${string}`; value?: bigint },
  network: "mainnet" = "mainnet",
  prepared?: TxPreparation,
): Promise<WalletSendResult> {
  const chainId = `0x${NETWORKS[network].chainId.toString(16)}` as `0x${string}`;
  try {
    const hash = await walletClient.request(
      {
        // viem's `request` forwards verbatim to the provider's `request`, so no
        // chain assertion and no nonce/gas estimation is performed through the
        // wallet — the only wallet call is this one submission. The envelope
        // fields the wallet would otherwise have to fetch are supplied by the app.
        method: "eth_sendTransaction",
        params: [
          buildSendParams({
            from: account,
            to: call.to,
            data: call.data,
            value: call.value,
            chainId,
            prepared,
          }),
        ],
      } as never,
      // A transaction submission must NEVER be retried. viem's transport default
      // is `retryCount: 3`, and it retries a *transport-shaped* failure (a wallet
      // that could not reach its own node — the Trust Wallet case). That
      // re-invokes `eth_sendTransaction` up to four times, so the wallet's
      // approval is shown again and the same payment can be broadcast more than
      // once. Every viem wallet action that signs or submits (`sendTransaction`,
      // `sendRawTransaction`, `signMessage`, …) passes `retryCount: 0` for this
      // exact reason; this raw `request` path replaced one of those, so it must
      // carry the same rule.
      { retryCount: 0 },
    );
    if (typeof hash !== "string" || !TX_HASH_RE.test(hash)) {
      return { ok: false, reason: "invalid_hash" };
    }
    return { ok: true, hash: hash as `0x${string}` };
  } catch (err) {
    if (isRejection(err)) return { ok: false, reason: "rejected", error: err };
    if (isUnsupported(err)) return { ok: false, reason: "unsupported", error: err };
    return { ok: false, reason: "send_failed", error: err };
  }
}
