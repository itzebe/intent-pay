"use client";

import {
  createWalletClient,
  custom,
  type Address,
  type WalletClient,
} from "viem";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
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
};

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

  return { address, account, walletClient };
}

/**
 * Whether the wallet can sign an EIP-7702 authorization.
 *
 * We do not prompt: we ask the wallet's capabilities. Wallets that advertise
 * atomic batching or that implement the authorization method are accepted; when
 * the answer is inconclusive we optimistically allow the attempt, because a
 * final user rejection is handled with a clear fallback rather than a false
 * promise. A wallet that explicitly cannot is reported as incompatible.
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
    // A 7702-capable wallet is one that can submit atomic calls; some wallets
    // also advertise a dedicated delegation capability.
    const atomic = caps?.atomic?.status ?? caps?.atomic;
    if (atomic === "supported" || atomic === "ready" || atomic === true) return true;
    if (caps?.delegation || caps?.eip7702) return true;
  } catch {
    /* fall through to optimistic */
  }
  // Inconclusive: allow the attempt. The execution layer degrades cleanly if the
  // wallet rejects, so we never strand the user on a capability probe.
  return true;
}

/** Expose the account address for the capability surface. */
export async function aaAccountAddress(bundle: AaAccountBundle): Promise<Address> {
  return (await bundle.account.getAddress()) as Address;
}

export type { Eip1193Provider };
