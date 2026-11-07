import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, custom, type WalletClient } from "viem";
import { stubAppRpc } from "./helpers/rpcStub";
import { executePlan } from "@/lib/execution/execute";
import { sendTransactionViaWallet } from "@/lib/wallet/sendTransaction";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";
import { monadMainnet } from "@/lib/config/chains";
import type { Quote } from "@/lib/domain/intent";

/**
 * Trust Wallet RPC independence (Mission 22).
 *
 * The reported customer failure is `Failed to connect to
 * http://monad.twnodes.com/`. That host is Trust Wallet's OWN NaaS RPC: its
 * in-app-browser provider answers `eth_chainId` (and any method it does not
 * handle natively) by proxying to that node from the page. When the read fails,
 * viem's high-level writers abort *before* ever calling `eth_sendTransaction` —
 * so the wallet is never given the transaction and the customer sees a dead end.
 *
 * These tests use a REAL viem wallet client over a REAL `custom` transport (not
 * a hand-rolled stub), with a provider that models Trust Wallet exactly:
 *   * `eth_accounts` / `eth_sendTransaction` are answered locally (native),
 *   * `eth_chainId` throws `TypeError: Failed to fetch` (its own node is blocked).
 *
 * The app's own Monad RPC stays available (the receipt read is stubbed to a
 * successful receipt), so the test proves the app completes a payment through
 * the wallet while the wallet's own RPC is down.
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
 * A Trust-Wallet-shaped provider: native methods work, its own RPC does not.
 * Records every method requested so a test can assert the app never asks the
 * wallet for a chain read.
 */
function trustProvider(log: string[], opts: { hash?: `0x${string}` } = {}) {
  return {
    request: async ({ method }: { method: string }) => {
      log.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [SENDER];
      if (method === "eth_chainId") {
        // The wallet proxies this to monad.twnodes.com; the page CSP blocks it.
        throw new TypeError("Failed to fetch");
      }
      if (method === "eth_sendTransaction") return opts.hash ?? HASH;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function trustWalletClient(log: string[], opts?: { hash?: `0x${string}` }): WalletClient {
  return createWalletClient({
    account: SENDER,
    chain: monadMainnet,
    transport: custom(trustProvider(log, opts) as never),
  });
}

describe("Trust Wallet RPC independence — execution", () => {
  // The app now prepares the transaction envelope through its own RPC, so stub
  // those reads. This keeps the test offline and proves the app — not the
  // wallet — supplies gas and fees.
  let rpc: ReturnType<typeof stubAppRpc>;
  beforeEach(() => {
    rpc = stubAppRpc();
  });
  afterEach(() => rpc.restore());

  it("completes a payment while the wallet's own chain read fails", async () => {
    const log: string[] = [];
    const result = await executePlan(directTransferPlan(), trustWalletClient(log), "mainnet");

    expect(result.confirmed).toBe(true);
    expect(result.primaryHash).toBe(HASH);
    // The wallet was asked ONLY to send — never to answer a chain read.
    expect(log).toEqual(["eth_sendTransaction"]);
    // The envelope came from the app's own RPC.
    expect(rpc.client.estimateGas).toHaveBeenCalled();
    expect(rpc.client.estimateFeesPerGas).toHaveBeenCalled();
  });

  it("hands the wallet the calldata, value and an explicit chainId", async () => {
    const sent: any[] = [];
    const provider = {
      request: async ({ method, params }: any) => {
        if (method === "eth_sendTransaction") {
          sent.push(params[0]);
          return HASH;
        }
        if (method === "eth_accounts") return [SENDER];
        if (method === "eth_chainId") throw new TypeError("Failed to fetch");
        throw new Error(`unexpected ${method}`);
      },
    };
    const wallet = createWalletClient({ account: SENDER, chain: monadMainnet, transport: custom(provider as never) });

    const res = await sendTransactionViaWallet(wallet, SENDER, {
      to: RECIPIENT,
      data: "0xdeadbeef",
      value: 1n,
    });

    expect(res).toEqual({ ok: true, hash: HASH });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: SENDER,
      to: RECIPIENT,
      data: "0xdeadbeef",
      value: "0x1",
      chainId: "0x8f", // Monad Mainnet, 143
    });
  });

  it("reports a user rejection as `rejected` (a definite failure)", async () => {
    const err: any = new Error("User rejected the request.");
    err.code = 4001;
    const wallet = createWalletClient({
      account: SENDER,
      chain: monadMainnet,
      transport: custom({ request: async () => { throw err; } } as never),
    });
    const res = await sendTransactionViaWallet(wallet, SENDER, { to: RECIPIENT });
    expect(res.ok).toBe(false);
    expect((res as any).reason).toBe("rejected");
  });

  it("reports a wallet transport fault as `send_failed` (may be on-chain)", async () => {
    const wallet = createWalletClient({
      account: SENDER,
      chain: monadMainnet,
      transport: custom({
        request: async () => { throw new TypeError("Failed to fetch"); },
      } as never),
    });
    const res = await sendTransactionViaWallet(wallet, SENDER, { to: RECIPIENT });
    expect(res.ok).toBe(false);
    expect((res as any).reason).toBe("send_failed");
  });

  it("rejects a non-hash reply from the wallet", async () => {
    const wallet = trustWalletClient([], { hash: "not-a-hash" as `0x${string}` });
    const res = await sendTransactionViaWallet(wallet, SENDER, { to: RECIPIENT });
    expect(res).toEqual({ ok: false, reason: "invalid_hash" });
  });

  // Non-vacuity: the OLD shape (viem `writeContract`) is what broke on Trust —
  // it reads `eth_chainId` through the wallet first and never reaches the send.
  it("demonstrates the old viem writeContract path fails on the same provider", async () => {
    const log: string[] = [];
    // Lower-case addresses bypass EIP-55 checksum validation so the failure is
    // the wallet's failing chain read, not an address-format error.
    const sender = SENDER.toLowerCase() as `0x${string}`;
    const wallet = createWalletClient({
      account: sender,
      chain: monadMainnet,
      transport: custom(trustProvider(log) as never),
    });
    const ABI = [
      { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
    ] as const;

    await expect(
      wallet.writeContract({
        account: sender,
        chain: monadMainnet,
        address: RECIPIENT,
        abi: ABI as any,
        functionName: "transfer",
        args: [RECIPIENT, 1n],
      }),
    ).rejects.toBeTruthy();

    // The wallet never received the transaction — only the failing chain read.
    expect(log).not.toContain("eth_sendTransaction");
    expect(log).toContain("eth_chainId");
  });
});
