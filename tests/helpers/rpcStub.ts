import { vi } from "vitest";
import { getClientPublicClient } from "@/lib/wallet/clients";

/**
 * Stub the browser public client's reads so an execution test never touches the
 * network.
 *
 * `executePlan` prepares the transaction envelope (gas / fees / nonce) through
 * the app's own RPC before the wallet is asked to sign. That is the fix for the
 * Trust Wallet `monad.twnodes.com` failure — but it means a unit test that calls
 * `executePlan` would otherwise make a real HTTP request. These spies keep the
 * suite offline and deterministic; pass overrides to model a specific reply.
 */
export function stubAppRpc(
  overrides: {
    estimateGas?: bigint | Error;
    estimateFeesPerGas?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } | Error;
    getTransactionCount?: number | Error;
    waitForTransactionReceipt?: unknown | Error;
    /** Set false when a test manages the receipt spy itself. Default true. */
    receipt?: boolean;
  } = {},
) {
  const client = getClientPublicClient("mainnet");

  const resolve = <T>(value: T | Error | undefined, fallback: T): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve((value as T) ?? fallback);

  const spies = [
    vi
      .spyOn(client, "estimateGas")
      .mockImplementation(() => resolve(overrides.estimateGas, 21_000n) as never),
    vi
      .spyOn(client, "estimateFeesPerGas")
      .mockImplementation(
        () =>
          resolve(overrides.estimateFeesPerGas, {
            maxFeePerGas: 122_000_000_000n,
            maxPriorityFeePerGas: 2_000_000_000n,
          }) as never,
      ),
    vi
      .spyOn(client, "getTransactionCount")
      .mockImplementation(() => resolve(overrides.getTransactionCount, 7) as never),
  ];

  if (overrides.receipt !== false) {
    spies.push(
      vi
        .spyOn(client, "waitForTransactionReceipt")
        .mockImplementation(
          () => resolve(overrides.waitForTransactionReceipt, { status: "success" }) as never,
        ) as never,
    );
  }

  return { client, restore: () => spies.forEach((s) => s.mockRestore()) };
}
