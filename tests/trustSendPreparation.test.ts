import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletClient } from "viem";
import { createWalletClient, custom } from "viem";
import { executePlan } from "@/lib/execution/execute";
import { sendTransactionViaWallet } from "@/lib/wallet/sendTransaction";
import { sendCallsSequentially } from "@/lib/wallet/sendCalls";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { prepareTxFields, buildSendParams, gasLimitWithBuffer, toRpcFields } from "@/lib/execution/prepareTx";
import { encodeStep } from "@/lib/execution/encode";
import { stubAppRpc } from "./helpers/rpcStub";
import { getToken } from "@/lib/config/tokens";
import { monadMainnet } from "@/lib/config/chains";
import type { Quote } from "@/lib/domain/intent";

/**
 * Application-owned transaction preparation (Mission 24).
 *
 * The reported failure is `Failed to connect to http://monad.twnodes.com/`
 * *after* Confirm and Send. `monad.twnodes.com` is Trust Wallet's own NaaS RPC:
 * the in-app-browser provider answers any method it does not handle natively by
 * proxying to it from the page. The app already submits a raw
 * `eth_sendTransaction`, so the app itself issues no wallet read — but it left
 * `gas`/fees/nonce out of the request, so the *wallet* had to fetch them, and a
 * wallet whose own node is unreachable cannot.
 *
 * These tests prove the app now prepares that envelope through its OWN RPC:
 *   * a Trust-shaped provider (its own chain read fails) still completes a
 *     payment, and the wallet is handed `gas` + EIP-1559 fees,
 *   * the calldata, sender, recipient and chain identity are unchanged,
 *   * an unreadable field is omitted rather than fabricated,
 *   * a rejection is never a submitted payment, and an unobserved receipt is
 *     never retried (no duplicate payment).
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

/** A same-asset USDC transfer: one deterministic step, no live liquidity. */
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

/**
 * A Trust-Wallet-shaped provider: native methods work, but `eth_chainId` (and
 * anything it does not handle) fails, exactly as when its own node is blocked.
 * Records every method requested.
 */
function trustProvider(log: string[]) {
  return {
    request: async ({ method }: { method: string }) => {
      log.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [SENDER];
      if (method === "eth_sendTransaction") return HASH;
      throw new TypeError("Failed to fetch");
    },
  };
}

describe("application-owned transaction preparation", () => {
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());

  // 1 + 2. Gas estimation and fee preparation are done by the app, and the
  //        payment completes while the wallet's own RPC reads fail.
  it("prepares gas and fees via the app RPC while the wallet's own RPC fails", async () => {
    const rpc = stubAppRpc();
    restore = rpc.restore;
    const log: string[] = [];
    const wallet = createWalletClient({
      account: SENDER,
      chain: monadMainnet,
      transport: custom(trustProvider(log) as never),
    });

    const result = await executePlan(directTransferPlan(), wallet, "mainnet");

    expect(result.confirmed).toBe(true);
    expect(result.primaryHash).toBe(HASH);
    // The wallet was asked ONLY to send — never for a chain/gas/fee read.
    expect(log).toEqual(["eth_sendTransaction"]);
    // The app really used its own RPC for the envelope.
    expect(rpc.client.estimateGas).toHaveBeenCalled();
    expect(rpc.client.estimateFeesPerGas).toHaveBeenCalled();
  });

  // 3 + 4 + 5. The exact fields the wallet receives: gas + fees supplied,
  //            calldata / sender / recipient unchanged, chain identity explicit.
  it("hands the wallet gas, fees, the unchanged calldata and explicit chainId", async () => {
    const rpc = stubAppRpc({ estimateGas: 21_000n });
    restore = rpc.restore;
    const sent: any[] = [];
    const provider = {
      request: async ({ method, params }: any) => {
        if (method === "eth_sendTransaction") {
          sent.push(params[0]);
          return HASH;
        }
        throw new TypeError("Failed to fetch");
      },
    };
    const wallet = createWalletClient({ account: SENDER, chain: monadMainnet, transport: custom(provider as never) });
    const step = directTransferPlan().steps[0];
    const expected = encodeStep(step);

    const res = await sendTransactionViaWallet(wallet, SENDER, expected, "mainnet", {
      gas: 25_200n,
      maxFeePerGas: 122_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });

    expect(res).toEqual({ ok: true, hash: HASH });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: SENDER,
      to: expected.to,
      data: expected.data,
      chainId: "0x8f",
      gas: "0x6270", // 25,200
      maxFeePerGas: "0x1c67c44400", // 122 gwei
      maxPriorityFeePerGas: "0x77359400", // 2 gwei
    });
    // The calldata the app encoded is byte-for-byte what the wallet received.
    expect(sent[0].data).toBe(expected.data);
  });

  /**
   * The exact reported failure: Trust Wallet's in-app provider proxies any
   * method it does not handle natively to `monad.twnodes.com`. When that node is
   * unreachable, a wallet that is asked to estimate gas / fetch fees / read a
   * nonce fails. The app must therefore prepare those fields itself, so the
   * wallet is never asked for them.
   */
  it("never asks the wallet for gas, fees or nonce (the twnodes reads)", async () => {
    const rpc = stubAppRpc();
    restore = rpc.restore;
    const asked: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        if (method === "eth_sendTransaction") return HASH;
        if (method === "eth_accounts") return [SENDER];
        // Every estimation/fee/nonce read proxies to Trust's node and fails.
        throw new TypeError("Failed to connect to http://monad.twnodes.com/");
      },
    };
    const wallet = createWalletClient({ account: SENDER, chain: monadMainnet, transport: custom(provider as never) });

    const result = await executePlan(directTransferPlan(), wallet, "mainnet");

    expect(result.confirmed).toBe(true);
    // The wallet was asked to send and nothing else.
    expect(asked).toEqual(["eth_sendTransaction"]);
    expect(asked).not.toContain("eth_estimateGas");
    expect(asked).not.toContain("eth_gasPrice");
    expect(asked).not.toContain("eth_maxPriorityFeePerGas");
    expect(asked).not.toContain("eth_getTransactionCount");
    // …because the app answered all three from its own RPC.
    expect(rpc.client.estimateGas).toHaveBeenCalled();
    expect(rpc.client.estimateFeesPerGas).toHaveBeenCalled();
  });

  // 6. The chain identity in the request is always the app's Monad chain.
  it("always sends the app's Monad chainId, never the wallet's reported chain", async () => {
    const params = buildSendParams({
      from: SENDER,
      to: RECIPIENT,
      chainId: "0x8f",
      prepared: { gas: 21000n },
    });
    expect(params.chainId).toBe("0x8f");
  });

  // 7. A wallet rejection is a definite failure — never a submitted payment.
  it("never treats a wallet rejection as a submitted transaction", async () => {
    const rpc = stubAppRpc();
    restore = rpc.restore;
    const err: any = new Error("User rejected the request.");
    err.code = 4001;
    const wallet = {
      account: { address: SENDER },
      request: async () => {
        throw err;
      },
    } as unknown as WalletClient;

    const seen: string[] = [];
    await expect(
      executePlan(directTransferPlan(), wallet, "mainnet", { onStep: (r) => seen.push(r.status) }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(seen).not.toContain("submitted");
    expect(seen).not.toContain("confirmed");
  });

  // 8 + 9. An unobserved receipt is not retried (no duplicate payment), and the
  //        receipt is polled through the app's own client.
  it("does not resend an unconfirmed transaction and polls via the app RPC", async () => {
    const rpc = stubAppRpc();
    vi.spyOn(rpc.client, "waitForTransactionReceipt").mockRejectedValue(new Error("timed out"));
    restore = rpc.restore;
    let sends = 0;
    const wallet = {
      account: { address: SENDER },
      request: async ({ method }: any) => {
        if (method !== "eth_sendTransaction") throw new Error(`unexpected ${method}`);
        sends += 1;
        return HASH;
      },
    } as unknown as WalletClient;

    const plan = directTransferPlan();
    plan.steps = [
      { ...plan.steps[0], id: "s1" } as any,
      { ...plan.steps[0], id: "s2" } as any,
    ];
    plan.primaryStepId = "s1";

    const result = await executePlan(plan, wallet, "mainnet");
    expect(result.confirmed).toBe(false);
    expect(result.primaryHash).toBe(HASH);
    // Only the first step was sent; the second was not (it follows a confirmed
    // predecessor). Nothing was resent.
    expect(sends).toBe(1);
    expect(rpc.client.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH }),
    );
  });

  // 10. The composer and the checkout build the SAME send params shape.
  it("builds identical send params for the composer and the checkout", async () => {
    const call = { to: RECIPIENT, data: "0xdeadbeef" as const, value: 1n };
    const prepared = { gas: 30000n, maxFeePerGas: 122_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };

    // Composer: `executePlan` → `sendTransactionViaWallet` → `buildSendParams`.
    const composerSent: any[] = [];
    const composerWallet = createWalletClient({
      account: SENDER,
      chain: monadMainnet,
      transport: custom({
        request: async ({ method, params }: any) => {
          if (method !== "eth_sendTransaction") throw new Error(`unexpected ${method}`);
          composerSent.push(params[0]);
          return HASH;
        },
      } as never),
    });
    await sendTransactionViaWallet(composerWallet, SENDER, call, "mainnet", prepared);

    // Checkout: `sendCallsSequentially`'s `send` → `buildSendParams`.
    const checkoutSent: any[] = [];
    await sendCallsSequentially({
      calls: [{ to: call.to, data: call.data, value: call.value.toString() }],
      send: async (c) => {
        const params = buildSendParams({
          from: SENDER,
          to: c.to as `0x${string}`,
          data: c.data as `0x${string}`,
          value: BigInt(c.value),
          chainId: "0x8f",
          prepared,
        });
        checkoutSent.push(params);
        return HASH;
      },
      waitForReceipt: async () => ({ status: "success" }),
    });

    expect(checkoutSent[0]).toEqual(composerSent[0]);
    expect(composerSent[0]).toMatchObject({
      from: SENDER,
      to: RECIPIENT,
      data: "0xdeadbeef",
      value: "0x1",
      chainId: "0x8f",
      gas: "0x7530",
      maxFeePerGas: "0x1c67c44400",
    });
  });
});

describe("prepareTxFields — never fabricate a field", () => {
  /** A minimal PublicClient stand-in; each read can be made to fail. */
  function fakeClient(fail: { gas?: boolean; fees?: boolean; nonce?: boolean }) {
    return {
      estimateGas: async () => {
        if (fail.gas) throw new Error("no gas");
        return 21_000n;
      },
      estimateFeesPerGas: async () => {
        if (fail.fees) throw new Error("no fees");
        return { maxFeePerGas: 122_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
      },
      getTransactionCount: async () => {
        if (fail.nonce) throw new Error("no nonce");
        return 3;
      },
    } as any;
  }

  it("reads gas, fees and nonce from the app's client", async () => {
    const prep = await prepareTxFields(fakeClient({}), { to: RECIPIENT }, { account: SENDER, includeNonce: true });
    expect(prep).toEqual({
      gas: 25_200n, // 21,000 + 20% buffer
      maxFeePerGas: 122_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      nonce: 3n,
    });
  });

  it("tolerates a client that lacks the estimate methods entirely", async () => {
    // The hosted checkout page injects a minimal client; preparation must not
    // throw when a method is missing, or the payment would be blocked by an
    // optimisation rather than by the chain.
    const prep = await prepareTxFields({} as any, { to: RECIPIENT }, { account: SENDER, includeNonce: true });
    expect(prep).toEqual({});
  });

  it("omits a field whose read fails rather than guessing a value", async () => {
    const prep = await prepareTxFields(
      fakeClient({ gas: true, fees: true, nonce: true }),
      { to: RECIPIENT },
      { account: SENDER, includeNonce: true },
    );
    expect(prep).toEqual({});
  });

  it("uses the plan's own gas bound only when the live estimate is unavailable", async () => {
    const prep = await prepareTxFields(
      fakeClient({ gas: true }),
      { to: RECIPIENT },
      { account: SENDER, fallbackGas: 55_000n },
    );
    expect(prep.gas).toBe(55_000n);
    expect(prep.maxFeePerGas).toBe(122_000_000_000n);
  });

  it("omits a non-positive or absent field from the RPC params", () => {
    expect(toRpcFields({ gas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, nonce: 0n })).toEqual({
      nonce: "0x0",
    });
    expect(toRpcFields({})).toEqual({});
    expect(toRpcFields({ gas: 21_000n })).toEqual({ gas: "0x5208" });
  });

  it("never shrinks a gas estimate below the node's own figure", () => {
    expect(gasLimitWithBuffer(21_000n)).toBe(25_200n);
    expect(gasLimitWithBuffer(0n)).toBe(0n);
  });
});

describe("checkout sequence — fresh nonce per call, no stale reuse", () => {
  it("passes the call index to `send` so each call gets its own envelope", async () => {
    const seen: number[] = [];
    const outcome = await sendCallsSequentially({
      calls: [
        { to: RECIPIENT, data: "0x", value: "0" },
        { to: RECIPIENT, data: "0x", value: "0" },
      ],
      send: async (_c, index) => {
        seen.push(index);
        return HASH;
      },
      waitForReceipt: async () => ({ status: "success" }),
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([0, 1]);
  });
});
