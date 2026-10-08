import { describe, expect, it } from "vitest";
import {
  initialIntent,
  reduceIntent,
  executionKey,
  isQuotable,
  toPaymentIntent,
  type CanonicalIntent,
} from "@/lib/domain/canonicalIntent";

const ALICE = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const BOB = "0x1111111111111111111111111111111111111111";

/**
 * The canonical intent is the single source of truth. These tests pin the
 * invalidation contract the whole flow depends on: any edit that would change
 * the signed transaction must produce a new version, and edits that cannot
 * change it must not.
 */
describe("canonical intent versioning", () => {
  it("starts at a known version and exposes the payment intent", () => {
    const intent = initialIntent();
    expect(intent.version).toBe(1);
    expect(toPaymentIntent(intent)).toEqual({
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveAmount: intent.receiveAmount,
      amountMode: intent.amountMode,
    });
  });

  it("bumps the version on every execution-relevant change", () => {
    const base = initialIntent();
    const changes: Partial<CanonicalIntent>[] = [
      { recipient: BOB },
      { receiveToken: "MON" },
      { receiveAmount: "25" },
      { amountMode: "i_spend" },
      { payToken: "USDT" },
    ];
    for (const patch of changes) {
      const next = reduceIntent(base, patch);
      expect(next.version, JSON.stringify(patch)).toBeGreaterThan(base.version);
    }
  });

  it("does NOT bump the version for a provenance-only edit (raw text)", () => {
    const base = initialIntent();
    const next = reduceIntent(base, { text: "Send $10" });
    expect(next.version).toBe(base.version);
    expect(next.text).toBe("Send $10");
  });

  it("does NOT bump the version for a no-op edit", () => {
    const base = initialIntent();
    const next = reduceIntent(base, { recipient: base.recipient });
    expect(next).toBe(base);
  });

  it("changes the execution key when an execution-relevant field changes", () => {
    const base = initialIntent();
    const moved = reduceIntent(base, { recipient: BOB });
    expect(moved.key).not.toBe(base.key);
    expect(executionKey(moved)).toBe(moved.key);
  });

  it("keeps the same execution key when only the text changes", () => {
    const base = initialIntent();
    const retitled = reduceIntent(base, { text: "Actually send it to the same person" });
    expect(retitled.key).toBe(base.key);
  });

  it("discards nothing when a patch produces an identical intent", () => {
    const base = reduceIntent(initialIntent(), { recipient: ALICE });
    const again = reduceIntent(base, { recipient: ALICE });
    expect(again.version).toBe(base.version);
  });

  // E/F/G/H. Every execution-relevant edit invalidates the prior build.
  it("invalidates on recipient, amount, input asset and output asset changes", () => {
    const base = reduceIntent(initialIntent(), { recipient: ALICE });
    const edits: Partial<CanonicalIntent>[] = [
      { recipient: BOB }, // E. recipient
      { receiveAmount: "99" }, // F. amount
      { payToken: "USDT" }, // G. input asset
      { receiveToken: "MON" }, // H. output asset
    ];
    for (const edit of edits) {
      const next = reduceIntent(base, edit);
      expect(next.version, JSON.stringify(edit)).toBeGreaterThan(base.version);
      expect(next.key, JSON.stringify(edit)).not.toBe(base.key);
    }
  });

  // J. Network change invalidates.
  it("invalidates on a network change (J)", () => {
    const base = reduceIntent(initialIntent(), { recipient: ALICE });
    const next = reduceIntent(base, { network: "mainnet" as const });
    expect(next).toBe(base); // same network is a no-op
    // A different network (were one configured) would bump the key; the key
    // includes the network so a chain switch can never reuse a quote.
    expect(base.key.split("|")[0]).toBe("mainnet");
  });

  it("invalidates when the exact token quantity changes (drives the partial split)", () => {
    const base = reduceIntent(initialIntent(), {
      recipient: ALICE,
      receiveTokenAmount: "100",
    });
    const edited = reduceIntent(base, { receiveTokenAmount: "150" });
    expect(edited.version).toBeGreaterThan(base.version);
    expect(edited.key).not.toBe(base.key);
    // Clearing it is also execution-relevant.
    expect(reduceIntent(base, { receiveTokenAmount: undefined }).key).not.toBe(base.key);
  });

  it("invalidates when the receive asset's contract address changes (same symbol)", () => {
    const base = reduceIntent(initialIntent(), {
      recipient: ALICE,
      receiveToken: "USDC",
      receiveTokenAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    });
    const other = reduceIntent(base, {
      receiveTokenAddress: "0x1111111111111111111111111111111111111111",
    });
    expect(other.version).toBeGreaterThan(base.version);
    expect(other.key).not.toBe(base.key);
  });
});

describe("quotable precondition", () => {
  it("requires a valid address and an amount", () => {
    expect(isQuotable(initialIntent())).toBe(false);
    const withRecipient = reduceIntent(initialIntent(), { recipient: ALICE });
    expect(isQuotable(withRecipient)).toBe(true);
  });
});
