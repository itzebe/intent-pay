import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { settlementToleranceBps, verifySettlement } from "@/lib/developer/settlement";
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
function fakeClient(
  receipts: Record<string, unknown>,
  txs: Record<string, unknown> = {},
  chainId = 143,
  failReceipt = false,
  opts: { head?: bigint; blocks?: Record<string, unknown>; failHead?: boolean; failBlock?: boolean } = {},
): PublicClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => {
      if (opts.failHead) throw new Error("rpc down");
      return opts.head ?? 1_000_000n;
    },
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
      if (opts.failBlock) throw new Error("rpc down");
      const key = String(blockNumber);
      const b = opts.blocks?.[key];
      if (!b) throw new Error("no block");
      return b;
    },
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

describe("verifySettlement — order binding (historical transfer protection)", () => {
  const blockTime = 1_700_000_000; // seconds
  const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(5_000_000n) }] };
  const blocks = { "100": { timestamp: BigInt(blockTime) } };

  it("verifies a transfer mined at/after the order was created", async () => {
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      notBeforeMs: blockTime * 1000 + 5_000,
      client: fakeClient({ [HASH]: receipt }, {}, 143, false, { blocks }),
    });
    expect(check.verdict).toBe("verified");
  });

  it("refuses a transfer that predates the order as historical", async () => {
    // The order was created well after the block that carried the transfer.
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      notBeforeMs: blockTime * 1000 + 3_600_000,
      client: fakeClient({ [HASH]: receipt }, {}, 143, false, { blocks }),
    });
    expect(check.verdict).toBe("historical");
  });

  it("is unavailable (not verified) when the block time cannot be read", async () => {
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      notBeforeMs: blockTime * 1000,
      client: fakeClient({ [HASH]: receipt }, {}, 143, false, { failBlock: true }),
    });
    expect(check.verdict).toBe("unavailable");
  });
});

describe("verifySettlement — finality policy", () => {
  const receipt = { status: "success", blockNumber: 1_000_000n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(5_000_000n) }] };

  it("verifies a receipt buried under enough confirmations", async () => {
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      client: fakeClient({ [HASH]: receipt }, {}, 143, false, { head: 1_000_002n }),
    });
    expect(check.verdict).toBe("verified");
  });

  it("does not verify a receipt that is not yet deep enough", async () => {
    // head == receipt block ⇒ 1 confirmation, below the default policy of 2.
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      client: fakeClient({ [HASH]: receipt }, {}, 143, false, { head: 1_000_000n }),
    });
    expect(check.verdict).toBe("unconfirmed");
  });

  it("is unavailable (not verified) when the chain height cannot be read", async () => {
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      client: fakeClient({ [HASH]: receipt }, {}, 143, false, { failHead: true }),
    });
    expect(check.verdict).toBe("unavailable");
  });
});

describe("verifySettlement — amount tolerance policy", () => {
  it("demands the exact amount for recipient_receives (0 bps)", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(4_999_000n) }] };
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      toleranceBps: settlementToleranceBps("recipient_receives"),
      client: fakeClient({ [HASH]: receipt }),
    });
    expect(check.verdict).toBe("short");
  });

  it("accepts the same shortfall for i_spend (50 bps tolerance)", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(4_999_000n) }] };
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      toleranceBps: settlementToleranceBps("i_spend"),
      client: fakeClient({ [HASH]: receipt }),
    });
    expect(check.verdict).toBe("verified");
  });

  it("records the exact delivered amount for an overpayment", async () => {
    const receipt = { status: "success", blockNumber: 100n, logs: [{ address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(294_949_053n) }] };
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "100",
      toleranceBps: settlementToleranceBps("recipient_receives"),
      client: fakeClient({ [HASH]: receipt }),
    });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("294.949053");
    expect(check.expected).toBe("100");
  });

  it("sums every relevant transfer event in one transaction", async () => {
    // Two transfers to the recipient in the same tx, plus noise: a transfer to
    // someone else and a transfer of a different token.
    const receipt = {
      status: "success",
      blockNumber: 100n,
      logs: [
        { address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(3_000_000n) },
        { address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(2_000_000n) },
        { address: USDC.address, topics: [TRANSFER_TOPIC, pad(OTHER), pad(OTHER)], data: word(9_000_000n) },
        { address: "0x00000000000000000000000000000000000000aa", topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)], data: word(9_000_000n) },
      ],
    };
    const check = await verifySettlement({
      txHash: HASH,
      recipient: RECIPIENT,
      receiveTokenAddress: USDC.address,
      receiveToken: "USDC",
      expectedAmount: "5",
      toleranceBps: settlementToleranceBps("recipient_receives"),
      client: fakeClient({ [HASH]: receipt }),
    });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("5");
  });
});
