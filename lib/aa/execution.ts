"use client";

import { createBundlerClient, type SmartAccount } from "viem/account-abstraction";
import { http, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { NETWORKS, type MonadNetwork } from "@/lib/config/chains";
import { ERC20_ABI, SWAP_ROUTER_ABI, WNATIVE_ABI } from "@/lib/execution/abis";
import { encodePath } from "@/lib/execution/path";
import { encodeStep, ExecutionError, type EncodedCall } from "@/lib/execution/execute";
import type { PaymentPlan, PlanStep } from "@/lib/execution/plan";
import { ENTRY_POINT_V08, SIMPLE_7702_ABI, SIMPLE_7702_IMPLEMENTATION } from "./abis";
import { aaRpcUrl } from "./endpoint";
import { createAaAccount, type Eip1193Provider } from "./account";
import { prepareSignedAuthorization, AaAuthorizationError } from "./authorization";
import { withGasBuffer } from "./safety";
import { filterUserOperation } from "./userOp";
import { planGasApproval, type GasPaymasterQuote } from "./gasApproval";
import type { PaymentStage } from "@/lib/domain/paymentDiagnostics";

/**
 * The authorization authority's EOA transaction nonce — the value EIP-7702
 * requires in the authorization tuple. This is NOT the UserOperation nonce.
 *
 * The UserOperation's nonce is an EntryPoint 2D nonce (a nonce *key* packed into
 * the high 192 bits); passing it as the authorization nonce would exceed the
 * `uint64` range EIP-7702 accepts and the authorization would be rejected. The
 * authority for a self-executing 7702 authorization is the sender EOA, and the
 * nonce is its pending transaction count — the same source viem's own
 * `prepareAuthorization` uses.
 *
 * Carrier-transaction note: in this path the authorization is embedded in an
 * EntryPoint UserOperation that the *bundler* submits; the sender is not the
 * outer transaction's signer, so no +1 adjustment applies.
 */
async function authorizationNonce(
  publicClient: PublicClient,
  authority: Address,
): Promise<bigint> {
  const count = await publicClient.getTransactionCount({
    address: authority,
    blockTag: "pending",
  });
  return BigInt(count);
}

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
  /**
   * The UserOperation was accepted by the bundler (a hash exists) but its
   * receipt was not obtained before the wait timed out. This is NOT a failure:
   * the payment may still land, so it must never be reported as failed and must
   * never be blindly resubmitted.
   */
  unconfirmed?: boolean;
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
    // Bound the proxy call: a stalled serverless function must surface as a
    // retryable error instead of leaving the UI on "Waiting for confirmation…"
    // forever.
    signal: timeoutSignal(AA_PAYMASTER_TIMEOUT_MS),
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

/** Hard ceiling for a single paymaster proxy round-trip. */
export const AA_PAYMASTER_TIMEOUT_MS = 20_000;

/** An AbortSignal that fires after `ms` (falls back to undefined when unsupported). */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
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
  /** Stage observer for the structured payment diagnostic trail. */
  onStage?: (stage: PaymentStage) => void,
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

  // --- Real EIP-7702 authorization (prepared, NOT broadcast) ---------------
  // viem's `prepareUserOperation` fills the operation with a *placeholder*
  // authorization when the 7702 account is not yet deployed; that placeholder is
  // not a valid signature and the EntryPoint rejects it (`AA20 account not
  // deployed` / `AA33`). We must therefore obtain the REAL signed authorization
  // from the wallet and pass it explicitly. This step signs only — it performs
  // no submission.
  //
  // The authorization nonce is the authority's EOA transaction nonce (pending),
  // NOT the UserOperation nonce: the UserOperation nonce is an EntryPoint 2D
  // nonce that exceeds EIP-7702's `uint64` bound. The two are deliberately
  // separate sources.
  const authority = sender;
  onStage?.("authorization_signing_started");
  const authNonce = await authorizationNonce(publicClient, authority);
  const authorized = await prepareSignedAuthorization({
    signer: bundle.authorizationSigner,
    owner: sender,
    chainId: NETWORKS[network].chain.id,
    implementation: SIMPLE_7702_IMPLEMENTATION,
    nonce: authNonce,
  }).catch((err) => {
    // A precise, pre-submission failure. Convert to an ExecutionError so the UI
    // shows the real reason (and keeps Review mounted) instead of a generic
    // message — and never silently fall back to native MON.
    if (err instanceof AaAuthorizationError) {
      throw new ExecutionError(err.message, "authorization_failed");
    }
    throw err;
  });
  onStage?.("authorization_signing_completed");
  const authorization = authorized.authorization;
  // viem 2.57.3 accepts this authorization at runtime — its `eip7702Auth`
  // formatter serialises the nonce with `numberToHex`, which handles `bigint` —
  // but its public `SignedAuthorization` type declares `nonce: number`. The nonce
  // stays a bigint on the wire; this is a type-only bridge, not a conversion.
  const authorizationForSdk = authorization as unknown as Parameters<
    typeof bundlerClient.sendUserOperation
  >[0]["authorization"];

  // Prepare (simulate + estimate gas) with the REAL authorization, so the gas
  // fields — and therefore the bounded allowance — are computed against the
  // operation that will actually be submitted.
  onStage?.("user_operation_preparation_started");
  onStage?.("paymaster_validation_started");
  const prepared = await bundlerClient.prepareUserOperation({
    account,
    calls,
    paymaster: erc20Paymaster(gasToken),
    paymasterContext: { token: gasToken },
    authorization: authorizationForSdk,
  });
  onStage?.("paymaster_validation_completed");
  onStage?.("user_operation_preparation_completed");

  const exactApproval = planGasApproval({
    userOperation: prepared as unknown as Record<string, unknown>,
    quote: liveQuote!,
    gasTokenBalance: gasTokenBalance!,
  });
  if (!exactApproval.ok) {
    throw new ExecutionError(exactApproval.reason ?? "Gas can't be paid in this token right now.", "unknown");
  }
  const finalCalls = [{ to: exactApproval.call.to, data: exactApproval.call.data, value: 0n }, ...paymentCalls];

  // The submission boundary: everything above is preparation; this is the only
  // state-changing call in the ERC-20 path.
  onStage?.("bundler_submission_started");
  const userOpHash = await bundlerClient.sendUserOperation({
    account,
    calls: finalCalls,
    paymaster: erc20Paymaster(gasToken),
    paymasterContext: { token: gasToken },
    authorization: authorizationForSdk,
  });
  onStage?.("bundler_submission_completed");

  plan.steps.forEach((s) => onStep?.({ stepId: s.id, label: s.label, status: "submitted" }));
  onStage?.("user_operation_pending");
  onStage?.("receipt_polling_started");

  // Wait for the receipt, but never let a timeout masquerade as a failure: the
  // UserOperation is already submitted (a real hash exists) and may still land.
  // A user must not be told the payment failed, and Retry must re-check status
  // rather than resubmit.
  let receipt: Awaited<ReturnType<typeof bundlerClient.waitForUserOperationReceipt>> | undefined;
  try {
    receipt = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
      timeout: 90_000,
    });
  } catch {
    plan.steps.forEach((s) =>
      onStep?.({
        stepId: s.id,
        label: s.label,
        status: "submitted",
        error: "Confirmation is taking longer than expected",
      }),
    );
    return {
      userOpHash,
      success: false,
      unconfirmed: true,
      logs: [],
      reason: "The transaction was submitted but not confirmed yet.",
    };
  }

  const success = Boolean(receipt?.success);
  onStage?.("user_operation_included");
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
    const res = await fetch(`/api/aa/paymaster?token=${token}`, {
      method: "GET",
      signal: timeoutSignal(AA_PAYMASTER_TIMEOUT_MS),
    });
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

/**
 * Ask the bundler for a submitted UserOperation's receipt without waiting.
 * Returns `undefined` while it is not yet available (or on any transient
 * error), so callers can poll a previously-submitted operation to determine its
 * true outcome instead of resubmitting it.
 */
export async function checkUserOperationReceipt(
  publicClient: PublicClient,
  network: MonadNetwork,
  userOpHash: Hash,
): Promise<AaExecutionResult | undefined> {
  try {
    const bundler = createBundlerClient({
      chain: NETWORKS[network].chain,
      client: publicClient,
      transport: http(aaRpcUrl(), { timeout: 30_000 }),
    });
    const receipt = await bundler.getUserOperationReceipt?.({ hash: userOpHash });
    if (!receipt) return undefined;
    const success = Boolean(receipt.success);
    return {
      userOpHash,
      transactionHash: receipt.receipt?.transactionHash as Hash | undefined,
      success,
      logs: (receipt.logs ?? []).map((l) => ({
        address: l.address,
        topics: l.topics as unknown as string[],
        data: l.data,
      })),
      actualGasCost: receipt.actualGasCost as bigint | undefined,
      reason: receipt.reason,
    };
  } catch {
    return undefined;
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
