import { describe, expect, it, vi } from "vitest";
import type { WalletClient } from "viem";
import { executePlan, ExecutionError } from "@/lib/execution/execute";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { getClientPublicClient } from "@/lib/wallet/clients";
import { getToken } from "@/lib/config/tokens";
import type { Quote } from "@/lib/domain/intent";

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;

/**
 * A direct same-asset transfer: the simplest executable plan (one step, no
 * swap). A same-asset payment needs no live liquidity, so this is fully
 * deterministic and never touches the network.
 */
function directTransferPlan() {
  const usdc = getToken("USDC")!;
  const quote: Quote = {
    intent: { recipient: RECIPIENT, receiveToken: "USDC", receiveAmount: "5", amountMode: "recipient_receives" },
    network: "mainnet",
    payToken: usdc,
    receiveToken: usdc,
    payAmount: "5",
    receiveAmount: "5",
    payUsd: 5,
    receiveUsd: 5,
    rate: 1,
    route: { kind: "direct", hops: [], path: ["USDC", "USDC"] },
    totalSenderCostUsd: 5.01,
    networkCostUsd: 0.01,
    quotedAt: Date.now(),
    exactOutput: false,
  };
  return buildPaymentPlan(quote, SENDER, RECIPIENT);
}

/** A rejecting wallet: writeContract throws the EIP-1193 user-rejection code. */
function rejectingWallet(): WalletClient {
  const err: any = new Error("User rejected the request.");
  err.code = 4001;
  return {
    account: { address: SENDER },
    writeContract: async () => {
      throw err;
    },
    sendTransaction: async () => {
      throw err;
    },
  } as unknown as WalletClient;
}

describe("executePlan — transaction rejection handling", () => {
  it("reports a user rejection as a `rejected` error and never a confirmed step", async () => {
    const seen: string[] = [];
    await expect(
      executePlan(directTransferPlan(), rejectingWallet(), "mainnet", {
        onStep: (r) => seen.push(r.status),
      }),
    ).rejects.toMatchObject({ code: "rejected" });

    // The step is reported as pending then failed — never confirmed/submitted.
    expect(seen).not.toContain("confirmed");
    expect(seen).not.toContain("submitted");
    expect(seen).toContain("failed");
  });

  it("surfaces the rejection message and step id (so the UI can retry)", async () => {
    try {
      await executePlan(directTransferPlan(), rejectingWallet(), "mainnet");
      throw new Error("expected executePlan to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).code).toBe("rejected");
      expect((err as ExecutionError).message).toMatch(/reject/i);
      expect((err as ExecutionError).stepId).toBeTruthy();
    }
  });

  it("refuses a non-executable plan rather than signing anything", async () => {
    const plan = { ...directTransferPlan(), executable: false };
    await expect(executePlan(plan, rejectingWallet(), "mainnet")).rejects.toMatchObject({
      code: "unknown",
    });
  });

  // N. A reverted on-chain transaction is never reported as successful.
  it("reports a reverted receipt as failed with a `reverted` error (N)", async () => {
    const hash = "0xreverted" as `0x${string}`;
    const wallet = {
      account: { address: SENDER },
      writeContract: async () => hash,
      sendTransaction: async () => hash,
    } as unknown as WalletClient;

    // Stub the receipt read to return a reverted receipt for our hash.
    const client = getClientPublicClient("mainnet");
    const spy = vi
      .spyOn(client, "waitForTransactionReceipt")
      .mockResolvedValue({ status: "reverted" } as any);

    try {
      const seen: string[] = [];
      await expect(
        executePlan(directTransferPlan(), wallet, "mainnet", {
          onStep: (r) => seen.push(r.status),
        }),
      ).rejects.toMatchObject({ code: "reverted" });
      expect(seen).not.toContain("confirmed");
      expect(seen).toContain("failed");
    } finally {
      spy.mockRestore();
    }
  });

  // O. A broadcast transaction whose receipt was never observed is NOT a
  //    success: the plan is unconfirmed, the hash is preserved, and the
  //    remaining steps are not run.
  it("reports an unobserved receipt as unconfirmed and stops the plan", async () => {
    const hash = "0xpending" as `0x${string}`;
    const sent: string[] = [];
    const wallet = {
      account: { address: SENDER },
      writeContract: async () => {
        sent.push("writeContract");
        return hash;
      },
      sendTransaction: async () => {
        sent.push("sendTransaction");
        return hash;
      },
    } as unknown as WalletClient;

    // Two steps: a second step must never be submitted once the first is
    // unconfirmed (it was built to follow a confirmed predecessor).
    const twoStep = { ...directTransferPlan() };
    twoStep.steps = [
      { ...twoStep.steps[0], id: "s1", kind: "transfer" } as any,
      { ...twoStep.steps[0], id: "s2", kind: "transfer" } as any,
    ];
    twoStep.primaryStepId = "s1";

    const client = getClientPublicClient("mainnet");
    const spy = vi
      .spyOn(client, "waitForTransactionReceipt")
      .mockRejectedValue(new Error("Timed out while waiting for transaction receipt"));

    try {
      const seen: { status: string; unconfirmed?: boolean; hash?: string }[] = [];
      const result = await executePlan(twoStep as any, wallet, "mainnet", {
        onStep: (r) => seen.push(r),
      });

      expect(result.confirmed).toBe(false);
      expect(result.primaryHash).toBe(hash);
      // The unconfirmed step keeps its hash and is flagged.
      const step = seen.find((s) => s.status === "submitted" && s.unconfirmed);
      expect(step?.hash).toBe(hash);
      // The second step was never submitted.
      expect(sent.length).toBe(1);
      expect(seen.some((s) => s.status === "confirmed")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
