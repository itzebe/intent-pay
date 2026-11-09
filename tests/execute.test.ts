import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletClient } from "viem";
import { stubAppRpc } from "./helpers/rpcStub";
import { executePlan, ExecutionError } from "@/lib/execution/execute";
import { classifyTransactionError, isWalletTransportFailure } from "@/lib/domain/transactionError";
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

/** A rejecting wallet: the submission throws the EIP-1193 user-rejection code. */
function rejectingWallet(): WalletClient {
  const err: any = new Error("User rejected the request.");
  err.code = 4001;
  return walletWith(async () => {
    throw err;
  });
}

/**
 * A wallet client that models the ONE method `executePlan` uses: a raw
 * `eth_sendTransaction` forwarded through `walletClient.request`.
 *
 * The execution layer deliberately does not call viem's high-level
 * `writeContract`/`sendTransaction`, because those read `eth_chainId` through
 * the wallet first — the read a Trust Wallet provider proxies to its own node
 * and cannot complete on Monad. `send` receives the params object so a test can
 * assert the calldata / `chainId` / `value` the wallet was actually handed.
 */
function walletWith(
  send: (params: {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
    chainId?: string;
  }) => Promise<unknown>,
): WalletClient {
  return {
    account: { address: SENDER },
    request: async ({ method, params }: any) => {
      if (method !== "eth_sendTransaction") {
        throw new Error(`unexpected wallet method ${method}`);
      }
      return send(params[0]);
    },
  } as unknown as WalletClient;
}

describe("executePlan — transaction rejection handling", () => {
  // `executePlan` prepares the transaction envelope (gas/fees) through the app's
  // own RPC before the wallet signs, so stub those reads to keep the suite
  // offline. Tests that manage the receipt spy themselves pass `receipt: false`.
  let rpc: ReturnType<typeof stubAppRpc>;
  beforeEach(() => {
    rpc = stubAppRpc();
  });
  afterEach(() => rpc.restore());

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
    const hash = ("0x" + "11".repeat(32)) as `0x${string}`;
    const wallet = walletWith(async () => hash);

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
    const hash = ("0x" + "22".repeat(32)) as `0x${string}`;
    const sent: string[] = [];
    const wallet = walletWith(async () => {
      sent.push("send");
      return hash;
    });

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

  // P. The real wallet/RPC failure is preserved on the thrown ExecutionError so
  //    the UI can name the actual cause instead of a generic fallback. This is
  //    the regression for the "returns to Confirm and Send with no explanation"
  //    report: the cause was being discarded.
  it("preserves the underlying provider error on `cause` (P)", async () => {
    const underlying = Object.assign(new Error("insufficient funds for gas * price + value"), {
      code: -32000,
    });
    const wallet = walletWith(async () => {
      throw underlying;
    });

    try {
      await executePlan(directTransferPlan(), wallet, "mainnet");
      throw new Error("expected executePlan to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).cause).toBe(underlying);
      // And the classifier now reads the real reason straight off the wrapper.
      const info = classifyTransactionError(err);
      expect(info.kind).toBe("insufficient_gas");
    }
  });

  // Q. A transport failure raised by the *wallet's* provider while it submits is
  //    the wallet's problem, not Intent Pay's RPC being down. The step id on the
  //    ExecutionError is what lets the UI tell the two apart — our own chain
  //    reads are made through our HTTPS clients and never carry a step id.
  it("marks a wallet-provider transport failure as the wallet's, not ours (Q)", async () => {
    const wallet = walletWith(async () => {
      throw new TypeError("Failed to fetch");
    });

    try {
      await executePlan(directTransferPlan(), wallet, "mainnet");
      throw new Error("expected executePlan to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      // The execution layer tags the failing step, so the boundary is knowable.
      expect((err as ExecutionError).stepId).toBeTruthy();
      expect(isWalletTransportFailure(err)).toBe(true);
      const info = classifyTransactionError(err, { source: "wallet" });
      expect(info.kind).toBe("wallet_rpc");
      // The wallet failed AFTER it was asked to send, so the transaction may
      // already be on-chain — it must NOT be reported as definitely unsent.
      expect(info.mayHaveSubmitted).toBe(true);
      expect(info.action).toBe("Check status");
      // It must never be reported as our RPC being unavailable.
      expect(info.kind).not.toBe("rpc_unavailable");
    }
  });

  // R. The reported Trust Wallet symptom: the wallet opens its native approval,
  //    the user enters their password, and only then does its native layer raise
  //    `Failed to connect to http://monad.twnodes.com/`. That is a transport
  //    failure *after* authorisation, so it is an unknown outcome — never a
  //    definite "not sent", and never a raw provider string.
  it("treats the Trust Wallet post-password connection error as an unknown outcome (R)", async () => {
    const wallet = walletWith(async () => {
      throw new TypeError("Failed to connect to http://monad.twnodes.com/");
    });

    try {
      await executePlan(directTransferPlan(), wallet, "mainnet");
      throw new Error("expected executePlan to throw");
    } catch (err) {
      expect(isWalletTransportFailure(err)).toBe(true);
      const info = classifyTransactionError(err, { source: "wallet" });
      expect(info.kind).toBe("wallet_rpc");
      expect(info.mayHaveSubmitted).toBe(true);
      expect(info.action).toBe("Check status");
      // The raw host must never reach the user.
      expect(info.message).not.toContain("twnodes");
      expect(info.message).not.toMatch(/monad\.twnodes/);
    }
  });

  // S. The reported post-PIN defect: a direct native MON transfer left the nonce
  //    to the wallet. The wallet fetches a missing nonce from its own node
  //    *after* the user authorises, and a wallet whose own node is unreachable
  //    (Trust Wallet's in-app browser proxying to `monad.twnodes.com`) then fails
  //    with a bare error — the "Transaction error" the user saw. Every step, even
  //    a single one, must be handed a complete envelope.
  it("hands the wallet a nonce for a single-step plan (S)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const wallet = walletWith(async (params) => {
      sent.push(params as Record<string, unknown>);
      return ("0x" + "ab".repeat(32)) as `0x${string}`;
    });

    await executePlan(directTransferPlan(), wallet, "mainnet");

    expect(sent).toHaveLength(1);
    // The app's own nonce (stubAppRpc returns 7) travels with the request, so the
    // wallet has nothing left to read before it can sign.
    expect(sent[0].nonce).toBe("0x7");
    expect(sent[0].gas).toBeTruthy();
    // The fee is the legacy `gasPrice` derived from the live EIP-1559 cap
    // (stubAppRpc returns maxFeePerGas 122 gwei) — Trust Wallet's dApp contract
    // reads `gasPrice` and ignores the EIP-1559 fields.
    expect(sent[0].gasPrice).toBe("0x1c67c44400");
    // Exactly one fee model: the EIP-1559 pair must NOT also be present, or the
    // request is a conflicting-fee transaction.
    expect(sent[0].maxFeePerGas).toBeUndefined();
    expect(sent[0].maxPriorityFeePerGas).toBeUndefined();
  });

  // U. The reported Trust Wallet defect: the dApp contract is legacy — it reads
  //    `gasPrice` and ignores `maxFeePerGas`/`maxPriorityFeePerGas`. The request
  //    must therefore carry the legacy fee field and must NOT also carry the
  //    EIP-1559 pair (a conflicting-fee transaction many wallets/nodes reject).
  it("sends the legacy gasPrice derived from the live maxFeePerGas, and only one fee model (U)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const wallet = walletWith(async (params) => {
      sent.push(params as Record<string, unknown>);
      return ("0x" + "ab".repeat(32)) as `0x${string}`;
    });

    // The stub returns maxFeePerGas = 122 gwei; the legacy gasPrice must equal it.
    await executePlan(directTransferPlan(), wallet, "mainnet");

    expect(sent).toHaveLength(1);
    const p = sent[0];
    // Exactly the legacy dApp transaction contract's field set (a USDC transfer
    // carries calldata, so `data` is present and `value` is absent) — nothing the
    // legacy decoder would ignore, and no second fee model.
    expect(Object.keys(p).sort()).toEqual(
      ["chainId", "data", "from", "gas", "gasPrice", "nonce", "to"].sort(),
    );
    expect(p.gasPrice).toBe("0x1c67c44400"); // 122_000_000_000
    expect(p).not.toHaveProperty("maxFeePerGas");
    expect(p).not.toHaveProperty("maxPriorityFeePerGas");
    expect(p).not.toHaveProperty("type");
  });

  // V. An invalid (zero/absent) fee estimate must not be turned into a fabricated
  //    gasPrice; the request then simply omits a fee and the wallet falls back to
  //    its own source — never a bogus "0x0" fee.
  it("omits the fee entirely when the estimate is unusable, never fabricating one (V)", async () => {
    const rpc2 = stubAppRpc({ estimateFeesPerGas: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n } });
    try {
      const sent: Array<Record<string, unknown>> = [];
      const wallet = walletWith(async (params) => {
        sent.push(params as Record<string, unknown>);
        return ("0x" + "ab".repeat(32)) as `0x${string}`;
      });
      await executePlan(directTransferPlan(), wallet, "mainnet");
      expect(sent[0]).not.toHaveProperty("gasPrice");
      expect(sent[0]).not.toHaveProperty("maxFeePerGas");
    } finally {
      rpc2.restore();
    }
  });

  // T. A submission failure the classifier cannot pin to a specific cause is
  //    still a *submission* failure: the wallet was asked to send (after the user
  //    authorised), so it must never be reported as a definite pre-submission
  //    failure with a plain Retry. It is an unknown outcome — may have submitted,
  //    status check required.
  it("reports an unrecognised submission failure as an unknown outcome, never a plain failure (T)", async () => {
    const wallet = walletWith(async () => {
      // The shape Trust Wallet's native layer can return: a bare, code-less
      // error carrying no diagnostic detail.
      throw new Error("Transaction error");
    });

    try {
      await executePlan(directTransferPlan(), wallet, "mainnet");
      throw new Error("expected executePlan to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionError);
      expect((err as ExecutionError).stepId).toBeTruthy();
      const info = classifyTransactionError(err, {
        source: isWalletTransportFailure(err) ? "wallet" : "app",
      });
      expect(info.kind).toBe("unknown_outcome");
      expect(info.mayHaveSubmitted).toBe(true);
      expect(info.action).toBe("Check status");
      expect(info.message).not.toMatch(/Transaction error/);
    }
  });
});
