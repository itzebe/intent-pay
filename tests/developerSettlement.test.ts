import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { verifySettlement } from "@/lib/developer/settlement";
import { getToken } from "@/lib/config/tokens";

/**
 * Independent settlement verification.
 *
 * The load-bearing honesty rule: a `success` receipt is not a payment. Only a
 * matching transfer of the requested asset to the requested recipient — within
 * the authorized slippage — is `verified`. A reverted transaction, a transfer to
 * the wrong recipient, an under-delivery, a missing transaction and an
 * unreachable chain each get their own verdict; none is ever "verified".
 */

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function pad(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}
function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

/** A fake client with a fixed chain id and receipt/tx lookups. */
function fakeClient(receipts: Record<string, unknown>, txs: Record<string, unknown> = {}, chainId = 143, failReceipt = false): PublicClient {
  return {
    getChainId: async () => chainId,
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (failReceipt) throw new Error("rpc down");
      const r = receipts[hash];
      if (!r) throw new Error("not found");
      return r;
    },
    getTransaction: async ({ hash }: { hash: string }) => txs[hash] ?? null,
  } as unknown as PublicClient;
}

const USDC = getToken("USDC")!;
const MON = getToken("MON")!;
const HASH = `0x${"a".repeat(64)}` as const;

describe("verifySettlement — ERC-20", () => {
  it("verifies a matching transfer within tolerance", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(5_000_000n) }] };
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({ [HASH]: receipt }) });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("5");
    expect(check.blockNumber).toBe(100);
  });

  it("does NOT verify a transfer to a different recipient", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(OTHER)], data: word(5_000_000n) }] };
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({ [HASH]: receipt }) });
    expect(check.verdict).toBe("short");
    expect(check.delivered).toBe("0");
  });

  it("does NOT verify an under-delivery", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(4_000_000n) }] };
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({ [HASH]: receipt }) });
    expect(check.verdict).toBe("short");
    expect(check.delivered).toBe("4");
  });

  it("treats a reverted transaction as reverted, never pending", async () => {
    const receipt = { status: "reverted", blockNumber: 100n, logs: [] };
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({ [HASH]: receipt }) });
    expect(check.verdict).toBe("reverted");
  });
});

describe("verifySettlement — native MON", () => {
  it("verifies a native transfer to the recipient", async () => {
    const receipt = { status: "success", blockNumber: 100n, to: RECIPIENT, logs: [] };
    const tx = { to: RECIPIENT, value: 10n * 10n ** 18n };
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: MON.address, receiveToken: "MON", expectedAmount: "10", client: fakeClient({ [HASH]: receipt }, { [HASH]: tx }) });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("10");
  });

  it("does not verify a native transfer to someone else", async () => {
    const receipt = { status: "success", blockNumber: 100n, to: OTHER, logs: [] };
    const tx = { to: OTHER, value: 10n * 10n ** 18n };
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: MON.address, receiveToken: "MON", expectedAmount: "10", client: fakeClient({ [HASH]: receipt }, { [HASH]: tx }) });
    expect(check.verdict).toBe("short");
  });
});

describe("verifySettlement — failure modes", () => {
  it("reports an invalid hash without touching the chain", async () => {
    const check = await verifySettlement({ txHash: "not-a-hash", recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({}) });
    expect(check.verdict).toBe("invalid_hash");
  });

  it("reports not_found when the transaction is unknown", async () => {
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({}) });
    expect(check.verdict).toBe("not_found");
  });

  it("reports unavailable when the chain cannot be reached", async () => {
    const client = { getChainId: async () => { throw new Error("down"); } } as unknown as PublicClient;
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client });
    expect(check.verdict).toBe("unavailable");
  });

  it("reports unavailable on the wrong chain", async () => {
    const check = await verifySettlement({ txHash: HASH, recipient: RECIPIENT, receiveTokenAddress: USDC.address, receiveToken: "USDC", expectedAmount: "5", client: fakeClient({}, {}, 1) });
    expect(check.verdict).toBe("unavailable");
    expect(check.chainId).toBe(1);
  });
});
