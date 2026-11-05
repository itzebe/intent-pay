import { describe, expect, it, vi } from "vitest";
import { sendCallsSequentially, isUserRejection, type RawCall } from "@/lib/wallet/sendCalls";

/**
 * The ordering rule for a multi-transaction payment.
 *
 * A swap is several sequential transactions (approve → swap → unwrap → deliver)
 * and each depends on its predecessor being mined. These tests assert the one
 * rule that makes it correct — send one, confirm it, then send the next — and
 * the contract that a failure never loses the hashes already broadcast.
 */

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const HASH_C = `0x${"c".repeat(64)}`;

function calls(n: number): RawCall[] {
  return Array.from({ length: n }, (_, i) => ({
    to: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    data: "0x1234",
    value: "0",
  }));
}

describe("sendCallsSequentially", () => {
  it("sends and confirms each call before sending the next", async () => {
    const order: string[] = [];
    const hashes = [HASH_A, HASH_B, HASH_C];
    let n = 0;

    const outcome = await sendCallsSequentially({
      calls: calls(3),
      send: async () => {
        const h = hashes[n++];
        order.push(`send:${h.slice(2, 6)}`);
        return h;
      },
      waitForReceipt: async (hash) => {
        order.push(`wait:${hash.slice(2, 6)}`);
        return { status: "success" };
      },
    });

    expect(outcome).toEqual({ ok: true, hashes: [HASH_A, HASH_B, HASH_C] });
    expect(order).toEqual([
      "send:aaaa", "wait:aaaa",
      "send:bbbb", "wait:bbbb",
      "send:cccc", "wait:cccc",
    ]);
  });

  it("stops at the first reverted transaction and keeps its hash", async () => {
    const sends = vi.fn(async () => HASH_A);
    const outcome = await sendCallsSequentially({
      calls: calls(3),
      send: sends,
      waitForReceipt: async () => ({ status: "reverted" }),
    });

    expect(outcome).toMatchObject({ ok: false, reason: "reverted", hashes: [HASH_A] });
    // The dependent calls were never broadcast.
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("treats a wallet rejection as a stop with no hashes", async () => {
    const sends = vi.fn(async () => {
      throw { code: 4001, message: "User rejected the request." };
    });
    const outcome = await sendCallsSequentially({
      calls: calls(2),
      send: sends,
      waitForReceipt: async () => ({ status: "success" }),
    });

    expect(outcome).toMatchObject({ ok: false, reason: "rejected", hashes: [] });
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("keeps earlier hashes when a later send fails", async () => {
    let n = 0;
    const outcome = await sendCallsSequentially({
      calls: calls(2),
      send: async () => {
        if (n++ === 0) return HASH_A;
        throw new Error("wallet disconnected");
      },
      waitForReceipt: async () => ({ status: "success" }),
    });

    expect(outcome).toMatchObject({ ok: false, reason: "send_failed", hashes: [HASH_A] });
  });

  it("rejects a non-hash return value without counting it", async () => {
    const outcome = await sendCallsSequentially({
      calls: calls(1),
      send: async () => "not-a-hash",
      waitForReceipt: async () => ({ status: "success" }),
    });

    expect(outcome).toMatchObject({ ok: false, reason: "invalid_hash", hashes: [] });
  });

  it("reports an unobserved receipt as unconfirmed but keeps the hash", async () => {
    const outcome = await sendCallsSequentially({
      calls: calls(2),
      send: async () => HASH_A,
      waitForReceipt: async () => {
        throw new Error("timeout");
      },
    });

    expect(outcome).toMatchObject({ ok: false, reason: "unconfirmed", hashes: [HASH_A] });
  });

  it("isUserRejection recognises only EIP-1193 code 4001", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ code: -32603 })).toBe(false);
    expect(isUserRejection(new Error("boom"))).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
});
