"use client";

import {
  createWalletClient,
  custom,
  numberToHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import type { AuthorizationSigner, AaSignedAuthorization } from "./authorization";
import { getClientPublicClient } from "@/lib/wallet/clients";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";
import { SIMPLE_7702_IMPLEMENTATION } from "./abis";

/**
 * EIP-7702 account construction for the connected injected wallet.
 *
 * The whole point of 7702 here is the *same-wallet* UX: the smart account's
 * address IS the user's existing EOA address. There is no new address, no
 * migration, and no separate wallet experience. The EOA delegates its code to a
 * pre-deployed implementation (Simple7702Account) for the duration of the
 * UserOperation.
 *
 * The implementation contract is verified to have bytecode on Monad mainnet.
 * The signer is the user's injected provider — Intent Pay never sees a key.
 */

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

/** The subset of a viem signer the 7702 account needs. */
type Signer = {
  address: Address;
  signMessage: (args: { message: unknown }) => Promise<`0x${string}`>;
  signTypedData: (args: unknown) => Promise<`0x${string}`>;
};

/** Build a viem signer that forwards signing to the injected wallet. */
function injectableSigner(
  walletClient: WalletClient,
  address: Address,
): Signer {
  return {
    address,
    signMessage: ({ message }) =>
      walletClient.signMessage({ account: address, message: message as never }),
    signTypedData: (typedData) =>
      walletClient.signTypedData({ account: address, ...(typedData as object) } as never),
  };
}

export type AaAccountBundle = {
  /** The user's EOA address — unchanged by 7702. */
  address: Address;
  /** A viem SmartAccount that signs UserOperations with the injected wallet. */
  account: Awaited<ReturnType<typeof toSimple7702SmartAccount>>;
  /** The wallet client used to sign the authorization + UserOperation. */
  walletClient: WalletClient;
  /**
   * The wallet's EIP-7702 authorization signer. Present only when the wallet
   * exposes a working authorization path; `prepareSignedAuthorization` refuses
   * to proceed without it rather than using a placeholder.
   */
  authorizationSigner?: AuthorizationSigner;
};

/**
 * Build an {@link AuthorizationSigner} from the injected provider.
 *
 * EIP-7702 does not standardize a JSON-RPC method for signing an authorization;
 * wallets expose wallet-specific capabilities (`eth_signAuthorization`,
 * `wallet_signAuthorization`, …). The provider is probed at signing time and the
 * fallback is only attempted when a method is genuinely unsupported — never
 * after a user rejection. If no method works, the signer throws and the caller
 * must not attempt the ERC-20 path with a fabricated signature.
 */
export function buildAuthorizationSigner(
  provider: Eip1193Provider | undefined,
  address: Address,
): { signer?: AuthorizationSigner; capable: boolean } {
  const request = provider?.request?.bind(provider);
  return {
    capable: Boolean(request),
    signer: request
      ? {
          address,
          signAuthorization: async (authorization) =>
            requestAuthorization(request, authorization),
        }
      : undefined,
  };
}

/**
 * Whether an error means the method is unsupported/not implemented — the only
 * case in which we may try an alternate method. A user rejection (4001) or any
 * other substantive error must propagate so the wallet is never asked twice.
 */
function isMethodUnsupported(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === "number" ? e.code : undefined;
  // EIP-1193 / JSON-RPC: 4200 unsupported method, -32601 method not found.
  if (code === 4200 || code === -32601) return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("method not found") ||
    msg.includes("unsupported method") ||
    msg.includes("not implemented") ||
    msg.includes("method does not exist") ||
    msg.includes("is not available")
  );
}

/** Call the wallet's authorization method and normalise the response. */
async function requestAuthorization(
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>,
  authorization: { address: Address; chainId: number; nonce: bigint },
): Promise<AaSignedAuthorization> {
  const params = {
    contractAddress: authorization.address,
    chainId: numberToHex(authorization.chainId),
    nonce: numberToHex(authorization.nonce),
  };
  let raw: unknown;
  let lastErr: unknown;
  for (const method of ["eth_signAuthorization", "wallet_signAuthorization"]) {
    try {
      raw = await request({ method, params });
      break;
    } catch (err) {
      lastErr = err;
      // Only a genuinely unsupported method permits trying the next one. A user
      // rejection or any other error stops here — no second signing prompt.
      if (!isMethodUnsupported(err)) throw err;
    }
  }
  if (raw === undefined) throw lastErr ?? new Error("No authorization method available");
  return normalizeSignedAuthorization(raw, authorization.address, authorization.nonce);
}

/**
 * Normalise a wallet's authorization response into our signed-authorization
 * shape.
 *
 * `r`/`s`/`yParity` may arrive as hex or decimal; a compact `signature` may be
 * returned instead; `v` (27/28) may stand in for `yParity` (0/1); `nonce` may be
 * bigint, number or 0x-hex. The nonce is kept as a `bigint` and defaults to the
 * nonce we requested.
 */
function normalizeSignedAuthorization(
  raw: unknown,
  fallbackAddress: Address,
  requestedNonce: bigint,
): AaSignedAuthorization {
  const a = (raw ?? {}) as Record<string, unknown>;
  const address = ((a.address ?? a.contractAddress ?? fallbackAddress) as string) as Address;
  const chainId = a.chainId !== undefined ? Number(a.chainId) : undefined;
  const nonce = a.nonce !== undefined ? toBigInt(a.nonce) : requestedNonce;

  let r = a.r as string | undefined;
  let s = a.s as string | undefined;
  let y: number | undefined =
    a.yParity !== undefined
      ? Number(a.yParity)
      : a.v !== undefined
        ? Number(a.v)
        : undefined;
  if (y !== undefined && y >= 27) y -= 27;

  if ((!r || !s) && typeof a.signature === "string" && a.signature.length >= 132) {
    const sig = a.signature.slice(2);
    r = `0x${sig.slice(0, 64)}`;
    s = `0x${sig.slice(64, 128)}`;
    y = Number.parseInt(sig.slice(128, 130), 16);
    if (y >= 27) y -= 27;
  }

  return {
    address,
    chainId: chainId ?? 0,
    nonce,
    r: (r ?? "0x") as Hex,
    s: (s ?? "0x") as Hex,
    yParity: y ?? 0,
  };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length) return BigInt(value);
  return 0n;
}

/**
 * Build the EIP-7702 smart account for the connected wallet.
 *
 * The returned account delegates to the pre-deployed Simple7702Account, so a
 * UserOperation executed through it keeps the user's own address and can carry
 * the batched approve+swap+deliver calls the payment planner produces.
 *
 * If the wallet cannot sign an EIP-7702 authorization, this throws; the caller
 * must fall back to native MON gas and say so — never fake it.
 */
export async function createAaAccount(
  provider: Eip1193Provider,
  address: Address,
  network: MonadNetwork,
): Promise<AaAccountBundle> {
  const chain = NETWORKS[network].chain;
  const publicClient = getClientPublicClient(network);
  const walletClient = createWalletClient({
    account: address,
    chain,
    transport: custom(provider as never),
  });

  const account = await toSimple7702SmartAccount({
    client: publicClient as never,
    owner: injectableSigner(walletClient, address) as never,
    implementation: SIMPLE_7702_IMPLEMENTATION,
  });

  return { address, account, walletClient, authorizationSigner: buildAuthorizationSigner(provider, address).signer };
}

/**
 * Whether the wallet can *attempt* an EIP-7702 UserOperation.
 *
 * This is an ATTEMPT-eligibility signal, not proof that the wallet can sign an
 * authorization: a generic capability probe cannot tell (it may advertise atomic
 * batching without exposing authorization signing, and `wallet_getCapabilities`
 * does not enumerate methods). We therefore:
 *  - return true when the wallet explicitly advertises EIP-7702 delegation, and
 *  - optimistically allow the attempt otherwise, because the authoritative check
 *    is the real signing during execution, which fails safely with a precise
 *    error (`unsupported_signer`) when the wallet cannot sign.
 *
 * The app never claims a *completed* authorization from this probe — the
 * capability endpoint reports the authorization as unverified separately.
 */
export async function walletSupportsEip7702(
  provider: Eip1193Provider | undefined,
  chainId: number,
): Promise<boolean> {
  if (!provider?.request) return false;
  try {
    const chainHex = "0x" + chainId.toString(16);
    const res = (await provider.request({
      method: "wallet_getCapabilities",
      params: [undefined, [chainHex]],
    })) as Record<string, any> | undefined;
    const caps = res?.[chainHex] ?? res?.[String(chainId)] ?? {};
    if (caps?.delegation || caps?.eip7702) return true;
  } catch {
    /* no capability data */
  }
  return true;
}

/** Expose the account address for the capability surface. */
export async function aaAccountAddress(bundle: AaAccountBundle): Promise<Address> {
  return (await bundle.account.getAddress()) as Address;
}

export type { Eip1193Provider };
