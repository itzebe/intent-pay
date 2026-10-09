"use client";

import { createBundlerClient, type SmartAccount } from "viem/account-abstraction";
import { http, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";
import { ERC20_ABI, SWAP_ROUTER_ABI, WNATIVE_ABI } from "@/lib/execution/abis";
import { encodePath } from "@/lib/execution/path";
import { encodeStep, ExecutionError, type EncodedCall } from "@/lib/execution/execute";
import type { PaymentPlan, PlanStep } from "@/lib/execution/plan";
import { ENTRY_POINT_V08, SIMPLE_7702_ABI } from "./abis";
import { aaRpcUrl } from "./endpoint";
import { createAaAccount, type Eip1193Provider } from "./account";
import { withGasBuffer } from "./safety";
import { filterUserOperation } from "./userOp";
import { planGasApproval, type GasPaymasterQuote } from "./gasApproval";

/**
 * EIP-7702 / ERC-4337 execution path (user pays gas in an ERC-20).
 *
 * This is a *different* execution path from the sequential EOA path, not a
 * relabelling of it. A normal EOA transaction cannot use a paymaster; the
 * payment's steps must be executed through a smart account as one UserOperation
 * so the paymaster can settle the fee in the gas token.
 *
 * Everything the user signs is a viem SmartAccount UserOperation. The paymaster
 * payload comes from the provider via the server proxy (the API key never
 * reaches the browser). Delivery is proven afterwards from the UserOperation's
 * real receipt, exactly as the EOA path proves it from transaction receipts.
 */

export type AaExecutionResult = {
  userOpHash: Hash;
  /** The on-chain transaction hash that included the UserOperation. */
  transactionHash?: Hash;
  success: boolean;
  /** Receipt logs, for delivery verification. */
  logs: { address: string; topics: string[]; data: string }[];
  actualGasCost?: bigint;
  reason?: string;
};

export type AaStepCallback = (step: {
  stepId: string;
  label: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  hash?: Hash;
  error?: string;
}) => void;

export type BundlerClientLike = ReturnType<typeof createBundlerClient>;

/** Build the bundler client that talks to the server-side AA proxy. */
export function createAaBundlerClient(
  account: Awaited<ReturnType<typeof createAaAccount>>["account"],
  network: MonadNetwork,
  publicClient: PublicClient,
): BundlerClientLike {
  return createBundlerClient({
    account,
    chain: NETWORKS[network].chain,
    client: publicClient,
    transport: http(aaRpcUrl(), { timeout: 30_000 }),
    // Paymaster fields are attached explicitly per send (see executePlanViaAa).
  }) as BundlerClientLike;
}

/**
 * Build a paymaster capability object whose `getPaymasterData` / `getPaymasterStubData`
 * delegate to the server proxy with `{ token }` context. This is what makes the
 * UserOperation carry real ERC-20 paymaster fields instead of a sponsorship
 * policy id.
 */
export function erc20Paymaster(token: Address) {
  return {
    async getPaymasterData(params: any) {
      return proxyPaymaster("pm_getPaymasterData", params, token);
    },
    async getPaymasterStubData(params: any) {
      return proxyPaymaster("pm_getPaymasterStubData", params, token);
    },
  };
}

async function proxyPaymaster(
  method: "pm_getPaymasterData" | "pm_getPaymasterStubData",
  params: any,
  token: Address,
) {
  const res = await fetch("/api/aa/paymaster", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method,
      userOperation: serializeUserOperation(params),
      entryPoint: params.entryPointAddress ?? ENTRY_POINT_V08,
      chainId: 143,
      token,
      // viem passes the op's EIP-7702 authorization under a transport-only key;
      // forward it so the provider can validate the authorization for a 7702
      // operation (EntryPoint v0.7+ names it `eip7702Auth`).
      ...(params.authorization ? { authorization: params.authorization } : {}),
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.message ?? "Paymaster request failed");
  return { ...json.result };
}

/**
 * Strip bigints for JSON transport and keep only real UserOperation fields.
 * viem's parameter bag also carries `chainId` / `entryPointAddress` / `context`,
 * which Pimlico rejects as unknown keys — see `filterUserOperation`.
 */
function serializeUserOperation(params: Record<string, unknown>): Record<string, unknown> {
  const out = filterUserOperation(params);
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "bigint") out[k] = "0x" + v.toString(16);
  }
  return out;
}

/**
 * Execute a payment plan through the 7702 account + ERC-20 paymaster, as one
 * atomic UserOperation:
 *   approvals → (wrap) → swap → (unwrap) → recipient transfer
 * with the paymaster settling the fee in `token` during postOp.
 *
 * Returns the real receipt so the caller can verify delivery.
 */
export async function executePlanViaAa(
  plan: PaymentPlan,
  provider: Eip1193Provider,
  sender: Address,
  network: MonadNetwork,
  gasToken: Address,
  publicClient: PublicClient,
  onStep?: AaStepCallback,
  /** The user's on-chain balance of the gas token, base units (bound the approval). */
  gasTokenBalance?: bigint,
): Promise<AaExecutionResult> {
  if (!plan.executable) {
    throw new Error("This payment has no executable on-chain route.");
  }

  const bundle = await createAaAccount(provider, sender, network);
  const account: SmartAccount = bundle.account as SmartAccount;
  const bundlerClient = createAaBundlerClient(bundle.account, network, publicClient);

  // Every plan step becomes a call in the batch, in order. Native-value steps
  // (wrap's msg.value) are preserved; the 7702 account's executeBatch supports
  // per-call value.
  const paymentCalls = plan.steps.map((s) => {
    const call = encodeStep(s);
    return { to: call.to as Address, data: call.data, value: call.value ?? 0n };
  });

  // --- Bounded ERC-20 gas allowance ---------------------------------------
  // Pimlico's ERC-20 paymaster recovers the fee with `transferFrom` in postOp,
  // so the UserOperation must approve the paymaster for at least the quoted
  // max cost *before* the payment calls. We use the live gas quote and
  // `boundGasSpend` to approve the MINIMUM bounded amount — never unlimited.
  const liveQuote = await fetchGasQuote(gasToken);
  const approvalPlan =
    liveQuote && gasTokenBalance !== undefined
      ? planGasApproval({
          // Approximate the UserOperation's own gas from the plan; the bound is
          // raised below with the exact post-prepare gas before sending.
          userOperation: {
            callGasLimit: 900_000n,
            verificationGasLimit: 900_000n,
            preVerificationGas: 120_000n,
            maxFeePerGas: await readMaxFeePerGas(bundlerClient),
          },
          quote: liveQuote,
          gasTokenBalance,
        })
      : { ok: false as const, reason: "No live gas quote or gas-token balance is available." };

  if (!approvalPlan.ok) {
    // Fail closed: without a bounded, quotable allowance we never send an
    // unbounded (or unapproved) UserOperation.
    throw new ExecutionError(
      approvalPlan.reason ?? "Gas can't be paid in this token right now.",
      "unknown",
    );
  }

  const calls = [{ to: approvalPlan.call.to, data: approvalPlan.call.data, value: 0n }, ...paymentCalls];

  plan.steps.forEach((s) => onStep?.({ stepId: s.id, label: s.label, status: "pending" }));

  // Prepare with the exact approval call so the gas fields (and therefore the
  // bounded allowance) are computed against the real UserOperation, then
  // re-bound the allowance with those exact fields before sending.
  const prepared = await bundlerClient.prepareUserOperation({
    account,
    calls,
    paymaster: erc20Paymaster(gasToken),
    paymasterContext: { token: gasToken },
  });

  const exactApproval = planGasApproval({
    userOperation: prepared as unknown as Record<string, unknown>,
    quote: liveQuote!,
    gasTokenBalance: gasTokenBalance!,
  });
  if (!exactApproval.ok) {
    throw new ExecutionError(exactApproval.reason ?? "Gas can't be paid in this token right now.", "unknown");
  }
  const finalCalls = [{ to: exactApproval.call.to, data: exactApproval.call.data, value: 0n }, ...paymentCalls];

  const userOpHash = await bundlerClient.sendUserOperation({
    account,
    calls: finalCalls,
    paymaster: erc20Paymaster(gasToken),
    paymasterContext: { token: gasToken },
  });

  plan.steps.forEach((s) => onStep?.({ stepId: s.id, label: s.label, status: "submitted" }));

  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash: userOpHash,
    timeout: 90_000,
  });

  const success = Boolean(receipt?.success);
  plan.steps.forEach((s) =>
    onStep?.({
      stepId: s.id,
      label: s.label,
      status: success ? "confirmed" : "failed",
      hash: receipt?.receipt?.transactionHash as Hash | undefined,
      error: success ? undefined : receipt?.reason ?? "UserOperation reverted",
    }),
  );

  return {
    userOpHash,
    transactionHash: receipt?.receipt?.transactionHash as Hash | undefined,
    success,
    logs: (receipt?.logs ?? []).map((l) => ({
      address: l.address,
      topics: l.topics as unknown as string[],
      data: l.data,
    })),
    actualGasCost: receipt?.actualGasCost as bigint | undefined,
    reason: receipt?.reason,
  };
}

/**
 * Fetch the live ERC-20 gas quote (paymaster, exchange rate, postOp gas) the
 * bounded allowance is derived from. Server-side key stays server-side.
 */
async function fetchGasQuote(token: Address): Promise<GasPaymasterQuote | null> {
  try {
    const res = await fetch(`/api/aa/paymaster?token=${token}`, { method: "GET" });
    const json = await res.json();
    if (!json.ok || !json.quote) return null;
    return {
      paymaster: json.quote.paymaster,
      token: json.quote.token,
      exchangeRate: BigInt(json.quote.exchangeRate),
      postOpGas: BigInt(json.quote.postOpGas),
    };
  } catch {
    return null;
  }
}

/** The bundler's current max fee per gas, for bounding the allowance. */
async function readMaxFeePerGas(bundlerClient: BundlerClientLike): Promise<bigint> {
  try {
    const prices = (await bundlerClient.request({
      method: "pimlico_getUserOperationGasPrice" as never,
      params: [] as never,
    })) as { standard?: { maxFeePerGas?: string } } | undefined;
    const hex = prices?.standard?.maxFeePerGas;
    return hex ? BigInt(hex) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Build the ordered calls for a plan (exposed for simulation/tests). Kept next
 * to the executor so the two can never drift.
 */
export function planToCalls(plan: PaymentPlan): EncodedCall[] {
  return plan.steps.map((s: PlanStep) => encodeStep(s));
}

export { ERC20_ABI, SWAP_ROUTER_ABI, WNATIVE_ABI, SIMPLE_7702_ABI, encodePath, withGasBuffer };
export type { Hex };
