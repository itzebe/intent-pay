import { describe, expect, it } from "vitest";
import { parseDetailed, mergeHints } from "@/lib/nlp/parser";
import { deriveState, missingField, sanitizePatch, emptyIntent } from "@/lib/nlp/schema";
import { nextClarification } from "@/lib/nlp/question";
import { planFromText, applyAsset, applyAddress, applyAmount } from "@/lib/nlp/engine";
import { draftToHandoff } from "@/lib/nlp/handoff";

const SYMBOLS = ["MON", "USDC", "USDT", "SOL", "WETH", "AUSD"];
const ctx = { symbols: SYMBOLS, network: "mainnet" as const };
const ADDR = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

describe("NL parser — amount forms are distinct", () => {
  it('"Send $10" -> USD_VALUE, no asset', () => {
    const i = parseDetailed("Send $10", ctx).intent;
    expect(i.amount).toBe("10");
    expect(i.amountType).toBe("USD_VALUE");
    expect(i.asset).toBeNull();
    expect(missingField(i)).toBe("asset");
    expect(deriveState(i)).toBe("NEEDS_ASSET");
  });

  it('"Send 10 MON" -> TOKEN_AMOUNT, asset MON', () => {
    const i = parseDetailed("Send 10 MON", ctx).intent;
    expect(i.amount).toBe("10");
    expect(i.amountType).toBe("TOKEN_AMOUNT");
    expect(i.asset).toBe("MON");
    expect(deriveState(i)).toBe("NEEDS_RECIPIENT");
  });

  it('"Send $10 worth of MON" -> USD_VALUE + asset MON', () => {
    const i = parseDetailed("Send $10 worth of MON", ctx).intent;
    expect(i.amount).toBe("10");
    expect(i.amountType).toBe("USD_VALUE");
    expect(i.asset).toBe("MON");
    expect(deriveState(i)).toBe("NEEDS_RECIPIENT");
  });

  it('"Send 10 USDC" -> TOKEN_AMOUNT USDC', () => {
    const i = parseDetailed("Send 10 USDC", ctx).intent;
    expect(i.amountType).toBe("TOKEN_AMOUNT");
    expect(i.asset).toBe("USDC");
  });

  it('"$10" and "10 MON" and "$10 worth of MON" are NOT equivalent', () => {
    const a = parseDetailed("Send $10", ctx).intent;
    const b = parseDetailed("Send 10 MON", ctx).intent;
    const c = parseDetailed("Send $10 worth of MON", ctx).intent;
    expect([a.amountType, a.asset]).toEqual(["USD_VALUE", null]);
    expect([b.amountType, b.asset]).toEqual(["TOKEN_AMOUNT", "MON"]);
    expect([c.amountType, c.asset]).toEqual(["USD_VALUE", "MON"]);
  });
});

describe("NL parser — recipient handling", () => {
  it('"Send 10 MON to 0x…" captures the explicit address', () => {
    const i = parseDetailed(`Send 10 MON to ${ADDR}`, ctx).intent;
    expect(i.recipientAddress?.toLowerCase()).toBe(ADDR.toLowerCase());
    expect(deriveState(i)).toBe("READY_FOR_QUOTE");
  });

  it('"Send John $10" records a name but never an address', () => {
    const i = parseDetailed("Send John $10", ctx).intent;
    expect(i.recipientName).toBe("John");
    expect(i.recipientAddress).toBeNull();
    expect(deriveState(i)).toBe("NEEDS_ASSET");
  });

  it('"Send $10 to John" asks which asset first (no silent asset choice)', () => {
    const i = parseDetailed("Send $10 to John", ctx).intent;
    expect(i.recipientName).toBe("John");
    expect(i.asset).toBeNull();
    expect(deriveState(i)).toBe("NEEDS_ASSET");
  });

  it("never turns a name into an address", () => {
    const i = parseDetailed("Send 10 MON to John", ctx).intent;
    expect(i.recipientAddress).toBeNull();
    expect(i.recipientName).toBe("John");
    expect(missingField(i)).toBe("recipient");
  });
});

describe("State machine — progressive collection", () => {
  it("amount -> asset -> recipient walk", () => {
    let i = parseDetailed("Send $10", ctx).intent;
    expect(deriveState(i)).toBe("NEEDS_ASSET");
    expect(nextClarification(i).expect).toBe("asset");

    i = applyAsset(i, "MON", SYMBOLS);
    expect(i.asset).toBe("MON");
    expect(deriveState(i)).toBe("NEEDS_RECIPIENT");
    expect(nextClarification(i).question).toContain("$10 in MON");

    i = applyAddress(i, ADDR);
    expect(deriveState(i)).toBe("READY_FOR_QUOTE");
  });

  it("rejects an invalid address and stays in NEEDS_RECIPIENT", () => {
    let i = parseDetailed("Send 10 MON", ctx).intent;
    i = applyAddress(i, "0xnotanaddress");
    expect(deriveState(i)).toBe("NEEDS_RECIPIENT");
  });

  it("rejects an unknown asset choice", () => {
    const i = applyAsset(emptyIntent(), "FAKECOIN", SYMBOLS);
    expect(i.asset).toBeNull();
  });

  it("rejects a non-positive amount", () => {
    const i = applyAmount(emptyIntent(), "0", "USD_VALUE");
    expect(i.amount).toBeNull();
  });
});

describe("Strict validation of untrusted (LLM) output", () => {
  it("drops unknown keys, addresses, prices and bad types", () => {
    const patch = sanitizePatch(
      {
        amount: "10",
        amountType: "USD_VALUE",
        asset: "MON",
        recipientName: "John",
        // Everything below must be discarded:
        price: 123.45,
        route: ["USDC", "MON"],
        address: ADDR,
        calldata: "0xdeadbeef",
        value: "999",
      },
      SYMBOLS,
    );
    expect(patch).toEqual({
      amount: "10",
      amountType: "USD_VALUE",
      asset: "MON",
      recipientName: "John",
    });
  });

  it("never lets the LLM invent a token outside the catalog", () => {
    const patch = sanitizePatch({ asset: "SCAMCOIN" }, SYMBOLS);
    expect(patch.asset).toBeUndefined();
  });

  it("only fills gaps — deterministic parse wins", () => {
    const base = parseDetailed("Send $10", ctx).intent; // USD_VALUE, no asset
    const merged = mergeHints(
      base,
      { patch: { amount: "999", amountType: "TOKEN_AMOUNT", asset: "MON" } },
      ctx,
    );
    // amount/type already known -> untouched; asset was missing -> filled.
    expect(merged.amount).toBe("10");
    expect(merged.amountType).toBe("USD_VALUE");
    expect(merged.asset).toBe("MON");
  });
});

describe("planFromText — engine", () => {
  it("returns state + clarification for a bare amount", () => {
    const plan = planFromText("Send $10", { symbols: SYMBOLS });
    expect(plan.state).toBe("NEEDS_ASSET");
    expect(plan.clarification.question).toMatch(/which asset/i);
  });

  it("uses an LLM hint only to fill gaps", () => {
    const plan = planFromText("Send ten dollars", {
      symbols: SYMBOLS,
      hint: { patch: { amount: "10", amountType: "USD_VALUE" } },
    });
    expect(plan.draft.amount).toBe("10");
    expect(plan.state).toBe("NEEDS_ASSET");
    expect(plan.llmUsed).toBe(true);
  });
});

describe("handoff to the existing composer", () => {
  it("USD_VALUE passes through unchanged (no price needed)", () => {
    const draft = parseDetailed(`Send $10 worth of MON to ${ADDR}`, ctx).intent;
    const r = draftToHandoff(draft, 0.03);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compose.receiveAmountUsd).toBe("10");
    expect(r.compose.receiveToken).toBe("MON");
    expect(r.compose.recipient.toLowerCase()).toBe(ADDR.toLowerCase());
  });

  it("TOKEN_AMOUNT uses the live price to compute USD", () => {
    const draft = parseDetailed(`Send 10 MON to ${ADDR}`, ctx).intent;
    const r = draftToHandoff(draft, 0.03);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 10 MON * $0.03 = $0.30
    expect(Number(r.compose.receiveAmountUsd)).toBeCloseTo(0.3, 6);
    expect(r.compose.tokenAmount).toBe("10");
  });

  it("refuses to fabricate when no live price exists", () => {
    const draft = parseDetailed(`Send 10 MON to ${ADDR}`, ctx).intent;
    const r = draftToHandoff(draft, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("price_unavailable");
  });

  it("refuses an incomplete draft", () => {
    const draft = parseDetailed("Send 10 MON", ctx).intent; // no recipient
    const r = draftToHandoff(draft, 0.03);
    expect(r.ok).toBe(false);
  });
});

describe("requested output asset is authoritative", () => {
  it("keeps MON even when the sender would more easily pay with USDC", () => {
    const draft = parseDetailed(`Send 10 MON to ${ADDR}`, ctx).intent;
    const r = draftToHandoff(draft, 0.03);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compose.receiveToken).toBe("MON");
  });
});
