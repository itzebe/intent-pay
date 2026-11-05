import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { settlementToleranceBps, verifySettlement } from "@/lib/developer/settlement";
import { getToken } from "@/lib/config/tokens";
import { derivePaymentAddress } from "@/lib/developer/xpub";

/**
 * Adversarial attribution tests for `verifySettlement`.
 *
 * The standard: a payment is accepted only when the transaction actually paid the
 * **destination this checkout defined**. Each case below is an attempt to make an
 * unrelated (or wrong) transfer look like a settlement, and each must be refused.
 * Only a transfer that matches destination, token contract, event, amount,
 * finality and order time is `verified`.
 *
 * These run the real verifier against a fake chain client, so a pass is the real
 * rule, not a mock's behaviour.
 */

const MERCHANT = "0x1111111111111111111111111111111111111111"; // the shared recipient
const CHECKOUT_DEST = "0x9999999999999999999999999999999999999999"; // this order's unique address
const OTHER_DEST = "0x8888888888888888888888888888888888888888"; // some other address
const ATTACKER = "0x2222222222222222222222222222222222222222";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HASH = `0x${"a".repeat(64)}` as const;
const USDC = getToken("USDC")!;

function pad(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}
function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}
function transfer(token: string, from: string, to: string, amount: bigint) {
  return { address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: word(amount) };
}

/** A fake client with a fixed, successful, deep-enough receipt. */
function fakeClient(logs: unknown[], opts: { head?: bigint; blockNumber?: bigint; blocks?: Record<string, unknown>; status?: string } = {}): PublicClient {
  const blockNumber = opts.blockNumber ?? 100n;
  return {
    getChainId: async () => 143,
    getBlockNumber: async () => opts.head ?? 1_000_002n,
    getBlock: async ({ blockNumber: bn }: { blockNumber?: bigint }) => {
      const b = opts.blocks?.[String(bn)];
      if (!b) throw new Error("no block");
      return b;
    },
    getTransactionReceipt: async () => ({ status: opts.status ?? "success", blockNumber, logs }),
    getTransaction: async () => null,
  } as unknown as PublicClient;
}

const BASE = {
  txHash: HASH,
  recipient: MERCHANT,
  destination: CHECKOUT_DEST,
  receiveTokenAddress: USDC.address,
  receiveToken: "USDC",
  expectedAmount: "5",
  toleranceBps: settlementToleranceBps("recipient_receives"),
};

describe("checkout-bound settlement — the happy path", () => {
  it("verifies a transfer to this order's unique destination", async () => {
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 5_000_000n)]) });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("5");
  });
});

describe("checkout-bound settlement — adversarial cases (all must be refused)", () => {
  it("1. refuses a transfer to the merchant's shared recipient (not this order's destination)", async () => {
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(USDC.address, ATTACKER, MERCHANT, 5_000_000n)]) });
    expect(check.verdict).not.toBe("verified");
    expect(check.delivered).toBe("0");
  });

  it("2. refuses a transfer to a different address entirely", async () => {
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(USDC.address, ATTACKER, OTHER_DEST, 5_000_000n)]) });
    expect(check.verdict).not.toBe("verified");
  });

  it("3. refuses a transfer to the destination of the WRONG token contract", async () => {
    const other = "0x00000000000000000000000000000000000000bb";
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(other, ATTACKER, CHECKOUT_DEST, 5_000_000n)]) });
    expect(check.verdict).not.toBe("verified");
  });

  it("4. refuses a transfer with the wrong event (an approval, not a transfer)", async () => {
    const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    const log = { address: USDC.address, topics: [APPROVAL_TOPIC, pad(ATTACKER), pad(CHECKOUT_DEST)], data: word(5_000_000n) };
    const check = await verifySettlement({ ...BASE, client: fakeClient([log]) });
    expect(check.verdict).not.toBe("verified");
  });

  it("5. refuses an under-delivery", async () => {
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 4_000_000n)]) });
    expect(check.verdict).toBe("short");
  });

  it("6. refuses a transfer that predates the order (historical)", async () => {
    const blockTime = 1_700_000_000;
    const check = await verifySettlement({
      ...BASE,
      notBeforeMs: blockTime * 1000 + 3_600_000,
      client: fakeClient([transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 5_000_000n)], { blocks: { "100": { timestamp: BigInt(blockTime) } } }),
    });
    expect(check.verdict).toBe("historical");
  });

  it("7. refuses a reverted transaction even if it carries a matching transfer log", async () => {
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 5_000_000n)], { status: "reverted" }) });
    expect(check.verdict).toBe("reverted");
  });

  it("8. does not verify a receipt that is not yet final", async () => {
    const check = await verifySettlement({ ...BASE, client: fakeClient([transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 5_000_000n)], { head: 100n }) });
    expect(check.verdict).toBe("unconfirmed");
  });

  it("9. refuses when the chain is unreachable", async () => {
    const client = { getChainId: async () => { throw new Error("down"); } } as unknown as PublicClient;
    const check = await verifySettlement({ ...BASE, client });
    expect(check.verdict).toBe("unavailable");
  });

  it("10. refuses a transfer on the wrong chain", async () => {
    const client = { getChainId: async () => 1, getBlockNumber: async () => 1n, getTransactionReceipt: async () => ({ status: "success", blockNumber: 1n, logs: [] }) } as unknown as PublicClient;
    const check = await verifySettlement({ ...BASE, client });
    expect(check.verdict).toBe("unavailable");
    expect(check.chainId).toBe(1);
  });

  it("11. refuses a malformed hash without touching the chain", async () => {
    const check = await verifySettlement({ ...BASE, txHash: "nope", client: fakeClient([]) });
    expect(check.verdict).toBe("invalid_hash");
  });

  it("12. refuses an unknown transaction", async () => {
    const client = { getChainId: async () => 143, getBlockNumber: async () => 1n, getTransactionReceipt: async () => { throw new Error("not found"); } } as unknown as PublicClient;
    const check = await verifySettlement({ ...BASE, client });
    expect(check.verdict).toBe("not_found");
  });

  it("13. counts only transfers to the destination, ignoring the right-amount transfer elsewhere", async () => {
    const logs = [
      transfer(USDC.address, ATTACKER, MERCHANT, 5_000_000n), // right amount, wrong destination
      transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 3_000_000n), // right destination, short
    ];
    const check = await verifySettlement({ ...BASE, client: fakeClient(logs) });
    expect(check.verdict).toBe("short");
    expect(check.delivered).toBe("3");
  });

  it("14. sums multiple transfers to the destination (split payment across one tx)", async () => {
    const logs = [
      transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 3_000_000n),
      transfer(USDC.address, ATTACKER, CHECKOUT_DEST, 2_000_000n),
      transfer(USDC.address, ATTACKER, OTHER_DEST, 9_000_000n),
    ];
    const check = await verifySettlement({ ...BASE, client: fakeClient(logs) });
    expect(check.verdict).toBe("verified");
    expect(check.delivered).toBe("5");
  });

  it("15. two different checkouts derive different destinations, so one transfer cannot settle both", async () => {
    const xpub = "xpub6Ce9NcJvTk36xtLSrJLZqE7wtgA5deCeYs7rSQtreh4cj6ByPtrg9sD7V2FNFLPnf8heNP3FGkeV9qwfzvZNSd54JoNXVsXFYSYwHsnJxqP";
    const d0 = derivePaymentAddress(xpub, 0);
    const d1 = derivePaymentAddress(xpub, 1);
    // A transfer to d0 verifies for checkout 0 and is refused for checkout 1.
    const logs = [transfer(USDC.address, ATTACKER, d0, 5_000_000n)];
    const forZero = await verifySettlement({ ...BASE, destination: d0, client: fakeClient(logs) });
    const forOne = await verifySettlement({ ...BASE, destination: d1, client: fakeClient(logs) });
    expect(forZero.verdict).toBe("verified");
    expect(forOne.verdict).not.toBe("verified");
  });
});

describe("checkout-bound settlement — native MON", () => {
  const MON = getToken("MON")!;
  function nativeClient(to: string, value: bigint): PublicClient {
    return {
      getChainId: async () => 143,
      getBlockNumber: async () => 1_000_002n,
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 100n, to, logs: [] }),
      getTransaction: async () => ({ to, value }),
    } as unknown as PublicClient;
  }

  it("verifies a native transfer to the order's destination", async () => {
    const check = await verifySettlement({
      txHash: HASH,
      recipient: MERCHANT,
      destination: CHECKOUT_DEST,
      receiveTokenAddress: MON.address,
      receiveToken: "MON",
      expectedAmount: "10",
      client: nativeClient(CHECKOUT_DEST, 10n * 10n ** 18n),
    });
    expect(check.verdict).toBe("verified");
  });

  it("refuses a native transfer to the shared recipient instead of the order destination", async () => {
    const check = await verifySettlement({
      txHash: HASH,
      recipient: MERCHANT,
      destination: CHECKOUT_DEST,
      receiveTokenAddress: MON.address,
      receiveToken: "MON",
      expectedAmount: "10",
      client: nativeClient(MERCHANT, 10n * 10n ** 18n),
    });
    expect(check.verdict).not.toBe("verified");
  });
});
