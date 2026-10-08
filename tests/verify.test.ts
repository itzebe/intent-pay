import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { verifyDelivery, verifyDeliveryFromLogs } from "@/lib/execution/verify";
import { parseUnits } from "@/lib/domain/math";
import { getToken } from "@/lib/config/tokens";
import { ERC20_ABI } from "@/lib/execution/abis";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function pad(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}
function word(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

/** A fake public client returning fixed receipts, keyed by hash. */
function fakeClient(receipts: Record<string, any>, txs: Record<string, any> = {}): PublicClient {
  return {
    getTransactionReceipt: async ({ hash }: any) => {
      const r = receipts[hash];
      if (!r) throw new Error("not found");
      return r;
    },
    getTransaction: async ({ hash }: any) => txs[hash] ?? null,
  } as unknown as PublicClient;
}

const USDC = getToken("USDC")!;
const MON = getToken("MON")!;

describe("ERC20_ABI includes the Transfer event", () => {
  // Regression: without the event in the ABI, decodeEventLog throws for every
  // log, so ERC-20 delivery verification could never prove delivery.
  it("decodes a Transfer log", () => {
    const decoded = decodeEventLog({
      abi: ERC20_ABI,
      topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)] as [
        `0x${string}`,
        ...`0x${string}`[],
      ],
      data: word(5_000_000n) as `0x${string}`,
    });
    expect((decoded.args as any).to.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect((decoded.args as any).value).toBe(5_000_000n);
  });
});

describe("verifyDelivery — ERC-20", () => {
  it("verifies when the recipient's Transfer covers the expected amount", async () => {
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)],
          data: word(5_000_000n), // 5 USDC (6dp)
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
    );
    expect(check.verified).toBe(true);
    expect(check.delivered).toBe("5");
  });

  it("does NOT verify a transfer sent to someone else", async () => {
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(RECIPIENT), pad(OTHER)],
          data: word(5_000_000n),
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
    );
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/less than intended/i);
  });

  it("does NOT verify an under-delivery", async () => {
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)],
          data: word(4_000_000n), // 4 USDC, expected 5
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
    );
    expect(check.verified).toBe(false);
  });
});

describe("verifyDelivery — native MON", () => {
  it("verifies a native delivery to the recipient", async () => {
    const receipt = { status: "success", to: RECIPIENT, logs: [] };
    const tx = { value: 10n * 10n ** 18n };
    const check = await verifyDelivery(
      fakeClient({ "0xdef": receipt }, { "0xdef": tx }),
      ["0xdef" as `0x${string}`],
      MON,
      RECIPIENT,
      "10",
    );
    expect(check.verified).toBe(true);
    expect(check.delivered).toBe("10");
  });
});

describe("verifyDelivery — protected minimum (M/O)", () => {
  it("verifies a fill that is below the quote but within the enforced slippage", async () => {
    // Quoted 5 USDC with a 1% tolerance → 4.95 floor. A 4.96 fill is fine.
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)],
          data: word(4_960_000n),
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
      100n, // 1%
    );
    expect(check.verified).toBe(true);
  });

  it("does NOT verify a fill below the enforced minimum (O)", async () => {
    // 4.90 < 4.95 floor: the recipient was short-changed past the tolerance.
    const receipt = {
      status: "success",
      logs: [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)],
          data: word(4_900_000n),
        },
      ],
    };
    const check = await verifyDelivery(
      fakeClient({ "0xabc": receipt }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
      100n,
    );
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/less than intended/i);
  });
});

describe("verifyDelivery — cannot prove", () => {
  it("reports no-transaction when there are no hashes", async () => {
    const check = await verifyDelivery(fakeClient({}), [], USDC, RECIPIENT, "5");
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/no transaction/i);
  });

  it("reports no successful receipt when every receipt is missing/reverted", async () => {
    const check = await verifyDelivery(
      fakeClient({ "0xabc": { status: "reverted", logs: [] } }),
      ["0xabc" as `0x${string}`],
      USDC,
      RECIPIENT,
      "5",
    );
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/no successful receipt/i);
  });
});

// ---------------------------------------------------------------------------
// UserOperation (ERC-20 gas) delivery verification
// ---------------------------------------------------------------------------
describe("verifyDeliveryFromLogs (ERC-20 gas / EIP-7702 path)", () => {
  it("verifies delivery when the recipient received at least the minimum", () => {
    const amount = parseUnits("5", USDC.decimals);
    const check = verifyDeliveryFromLogs(
      [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)],
          data: word(amount),
        },
      ],
      USDC,
      RECIPIENT,
      "5",
      50n,
    );
    expect(check.verified).toBe(true);
    expect(check.delivered).toBe("5");
  });

  it("fails when the recipient received below the protected minimum", () => {
    // 4.9 USDC delivered against 5 expected at 50 bps tolerance (min 4.975).
    const delivered = parseUnits("4.9", USDC.decimals);
    const check = verifyDeliveryFromLogs(
      [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(RECIPIENT)],
          data: word(delivered),
        },
      ],
      USDC,
      RECIPIENT,
      "5",
      50n,
    );
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/less than intended/);
  });

  it("ignores transfers to anyone other than the recipient", () => {
    const amount = parseUnits("5", USDC.decimals);
    const check = verifyDeliveryFromLogs(
      [
        {
          address: USDC.address,
          topics: [TRANSFER_TOPIC, pad(OTHER), pad(OTHER)],
          data: word(amount),
        },
      ],
      USDC,
      RECIPIENT,
      "5",
      50n,
    );
    expect(check.verified).toBe(false);
  });

  it("never reports success with no logs at all", () => {
    const check = verifyDeliveryFromLogs([], USDC, RECIPIENT, "5", 50n);
    expect(check.verified).toBe(false);
    expect(check.reason).toBe("no logs");
  });

  it("refuses to claim native delivery from logs alone", () => {
    const check = verifyDeliveryFromLogs(
      [{ address: MON.address, topics: [], data: "0x" }],
      MON,
      RECIPIENT,
      "5",
      50n,
    );
    expect(check.verified).toBe(false);
    expect(check.reason).toMatch(/cannot be proven/);
  });
});
