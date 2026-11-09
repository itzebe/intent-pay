import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WalletClient } from "viem";
import { stubAppRpc } from "./helpers/rpcStub";
import { executePlan } from "@/lib/execution/execute";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";
import type { Quote } from "@/lib/domain/intent";

/**
 * Trust Wallet dApp-contract regression (non-broadcasting).
 *
 * Trust Wallet's dApp transaction layer is LEGACY-fee: its own open-source
 * decoders read `from,to,value,gas|gasLimit,gasPrice,data,nonce` and IGNORE
 * `maxFeePerGas` / `maxPriorityFeePerGas` (iOS
 * `Trust/Browser/Types/SendTransaction.swift` + `DappAction.makeUnconfirmedTransaction`;
 * Android `Web3View` `processTransaction`), and wallet-core's signer defaults to
 * `tx_mode = Legacy`, whose only fee field is `gasPrice`.
 *
 * Intent Pay used to send the EIP-1559 pair with NO `gasPrice`, so the wallet's
 * legacy path had no usable fee and failed after the user authorised with a bare
 * "Transaction error". This test models that contract and asserts the envelope
 * the app now produces is accepted — the Mission 20 reproduction, made permanent.
 *
 * Nothing here signs or broadcasts: the "wallet" is a contract model.
 */

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

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

/** The field set Trust Wallet's dApp decoder reads; everything else is ignored. */
const DAPP_FIELDS = new Set(["from", "to", "value", "gas", "gasLimit", "gasPrice", "data", "nonce"]);

function hexBig(v: unknown): bigint | undefined {
  if (typeof v !== "string") return undefined;
  if (v === "" || v === "0x") return 0n;
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
}

/**
 * The native signer step: a legacy tx needs a usable `gasPrice`. Returns the
 * outcome the wallet's native layer would produce — a bare "Transaction error"
 * when the legacy fee is missing/zero, exactly the reported symptom.
 */
function dappContractVerdict(params: Record<string, unknown>): "accepted" | "Transaction error" {
  if (typeof params.from !== "string" || typeof params.to !== "string") return "Transaction error";
  const gasPrice = hexBig(params.gasPrice);
  if (gasPrice === undefined || gasPrice === 0n) return "Transaction error";
  return "accepted";
}

describe("Trust Wallet dApp contract — the produced envelope is legacy-compatible", () => {
  let rpc: ReturnType<typeof stubAppRpc>;
  beforeEach(() => {
    rpc = stubAppRpc();
  });
  afterEach(() => rpc.restore());

  function capturingWallet(sink: Record<string, unknown>[]): WalletClient {
    return {
      account: { address: SENDER },
      request: async ({ method, params }: any) => {
        if (method !== "eth_sendTransaction") throw new Error(`unexpected ${method}`);
        sink.push(params[0] as Record<string, unknown>);
        return HASH;
      },
    } as unknown as WalletClient;
  }

  it("the app's real submission is accepted by the legacy dApp contract", async () => {
    const sent: Record<string, unknown>[] = [];
    const result = await executePlan(directTransferPlan(), capturingWallet(sent), "mainnet");

    expect(result.confirmed).toBe(true);
    expect(sent).toHaveLength(1);

    // The wallet reads these keys; `chainId` is also present but the legacy
    // decoder ignores it (harmless). No EIP-1559 fee field is sent.
    for (const key of Object.keys(sent[0])) {
      expect(DAPP_FIELDS.has(key) || key === "chainId").toBe(true);
    }
    expect(sent[0].gasPrice).toBeTruthy();
    expect(dappContractVerdict(sent[0])).toBe("accepted");
  });

  it("would have FAILED before the fix (EIP-1559-only envelope, no gasPrice)", () => {
    // The exact shape the app used to send: the EIP-1559 pair, no gasPrice.
    const legacyBugEnvelope = {
      from: SENDER,
      to: RECIPIENT,
      value: "0x1",
      chainId: "0x8f",
      gas: "0x6270",
      maxFeePerGas: "0x1c67c44400",
      maxPriorityFeePerGas: "0x77359400",
      nonce: "0x7",
    };
    // `chainId`/`maxFeePerGas`/`maxPriorityFeePerGas` are not read by the legacy
    // decoder, and with no `gasPrice` the native signer fails.
    expect(dappContractVerdict(legacyBugEnvelope)).toBe("Transaction error");
  });

  it("never sends both fee models (a conflicting-fee transaction)", async () => {
    const sent: Record<string, unknown>[] = [];
    await executePlan(directTransferPlan(), capturingWallet(sent), "mainnet");
    expect(sent[0]).not.toHaveProperty("maxFeePerGas");
    expect(sent[0]).not.toHaveProperty("maxPriorityFeePerGas");
  });
});
