import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { checkTransactionSet, settlementToleranceBps, summarizeChecks, type SettlementCheck } from "@/lib/developer/settlement";
import { getToken } from "@/lib/config/tokens";

/**
 * Settlement across a multi-transaction plan.
 *
 * A swap payment is several sequential transactions (approve → swap → unwrap →
 * deliver). The transaction that pays the recipient is **not** necessarily the
 * first — the first is usually the ERC-20 approval, which transfers nothing to
 * the recipient. Verifying only the first hash therefore reports `short` for a
 * real, completed payment and the order can never settle. These tests drive the
 * real `checkTransactionSet` against a hash-aware fake chain, so a pass reflects
 * the production rule rather than a mock's behaviour.
 */

const DEST = "0x9999999999999999999999999999999999999999";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC = getToken("USDC")!;
const APPROVE_HASH = `0x${"1".repeat(64)}` as const;
const SWAP_HASH = `0x${"2".repeat(64)}` as const;

function pad(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}
function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}
function transfer(to: string, amount: bigint) {
  return { address: USDC.address, topics: [TRANSFER_TOPIC, pad(ATTACKER), pad(to)], data: word(amount) };
}

/** A fake client whose receipt depends on the requested hash. */
function hashAwareClient(receipts: Record<string, { logs: unknown[]; status?: string }>): PublicClient {
  return {
    getChainId: async () => 143,
    getBlockNumber: async () => 1_000_002n,
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const r = receipts[hash];
      if (!r) throw new Error("no receipt");
      return { status: r.status ?? "success", blockNumber: 100n, logs: r.logs };
    },
    getTransaction: async () => null,
  } as unknown as PublicClient;
}

const BASE = {
  recipient: DEST,
  destination: DEST,
  receiveTokenAddress: USDC.address,
  receiveToken: "USDC",
  expectedAmount: "5",
  toleranceBps: settlementToleranceBps("recipient_receives"),
};

describe("checkTransactionSet — a swap's delivering transaction is not the first", () => {
  it("verifies from a later hash when the first (the approval) transfers nothing", async () => {
    const client = hashAwareClient({
      [APPROVE_HASH]: { logs: [] }, // an approval: no Transfer to the destination
      [SWAP_HASH]: { logs: [transfer(DEST, 5_000_000n)] }, // the swap delivers
    });
    const check = await checkTransactionSet([APPROVE_HASH, SWAP_HASH], { ...BASE, client });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("5");
    // The verdict names the hash that actually delivered, so the caller can
    // claim the right transaction.
    expect(check.txHash).toBe(SWAP_HASH);
  });

  it("verifies a single-transaction payment unchanged", async () => {
    const client = hashAwareClient({ [SWAP_HASH]: { logs: [transfer(DEST, 5_000_000n)] } });
    const check = await checkTransactionSet([SWAP_HASH], { ...BASE, client });
    expect(check.verdict).toBe("verified");
    expect(check.txHash).toBe(SWAP_HASH);
  });

  it("is short only when no transaction delivered to the destination", async () => {
    const client = hashAwareClient({
      [APPROVE_HASH]: { logs: [] },
      [SWAP_HASH]: { logs: [transfer("0x1111111111111111111111111111111111111111", 5_000_000n)] },
    });
    const check = await checkTransactionSet([APPROVE_HASH, SWAP_HASH], { ...BASE, client });
    expect(check.verdict).toBe("short");
  });

  it("returns not_found for an empty hash list", async () => {
    const check = await checkTransactionSet([], { ...BASE, client: hashAwareClient({}) });
    expect(check.verdict).toBe("not_found");
  });

  it("prefers a definitive failure over a transient state on another hash", async () => {
    // One hash reverted (definitive), another is still unconfirmed (transient).
    // The reported verdict must be the reverted one, never a soft "retry".
    const client = hashAwareClient({
      [APPROVE_HASH]: { logs: [], status: "reverted" },
      [SWAP_HASH]: { logs: [] },
    });
    const check = await checkTransactionSet([SWAP_HASH, APPROVE_HASH], { ...BASE, client });
    expect(check.verdict).toBe("reverted");
  });
});

describe("summarizeChecks — verdict precedence", () => {
  const v = (verdict: SettlementCheck["verdict"]): SettlementCheck => ({ verdict, delivered: null, expected: "5", blockNumber: null, chainId: 143, message: "" });

  it("ranks a definitive failure above a transient state", () => {
    expect(summarizeChecks([v("unavailable"), v("reverted")]).verdict).toBe("reverted");
    expect(summarizeChecks([v("pending"), v("short")]).verdict).toBe("short");
  });

  it("ranks a transient state above a bare not_found", () => {
    expect(summarizeChecks([v("not_found"), v("unconfirmed")]).verdict).toBe("unconfirmed");
  });

  it("returns the only check when there is one", () => {
    expect(summarizeChecks([v("historical")]).verdict).toBe("historical");
  });
});
