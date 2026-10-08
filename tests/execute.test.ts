import { describe, expect, it, vi } from "vitest";
import type { WalletClient } from "viem";
import { executePlan, executePlanBatched, ExecutionError } from "@/lib/execution/execute";
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
});

describe("executePlanBatched — rejection and non-confirmation", () => {
  const providerRejecting = () => ({
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "wallet_sendCalls") {
        const err: any = new Error("User rejected the request.");
        err.code = 4001;
        throw err;
      }
      throw new Error(`unsupported ${method}`);
    }),
  });

  it("maps a rejected wallet_sendCalls to a `rejected` error and reports no confirmed step", async () => {
    const seen: string[] = [];
    await expect(
      executePlanBatched(
        directTransferPlan(),
        providerRejecting() as any,
        SENDER,
        143,
        "mainnet",
        {},
        { onStep: (r) => seen.push(r.status) },
      ),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(seen).not.toContain("confirmed");
    expect(seen).toContain("failed");
  });

  it("treats a non-confirmed batch status as a failure, never success", async () => {
    const provider = {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "wallet_sendCalls") return { id: "0xabc" };
        if (method === "wallet_getCallsStatus") return { status: 500 };
        throw new Error(`unsupported ${method}`);
      }),
    };
    const seen: string[] = [];
    await expect(
      executePlanBatched(directTransferPlan(), provider as any, SENDER, 143, "mainnet", {}, {
        onStep: (r) => seen.push(r.status),
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
    expect(seen).not.toContain("confirmed");
    expect(seen).toContain("failed");
  });
});
