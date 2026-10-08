import { describe, expect, it } from "vitest";
import {
  initialIntent,
  reduceIntent,
  displayKey,
  type CanonicalIntent,
} from "@/lib/domain/canonicalIntent";
import { draftFromIntent, nlDraftToIntentPatch } from "@/lib/nlp/apply";
import { emptyIntent, type ParsedPaymentIntent } from "@/lib/nlp/schema";
import { prepareSigning, type SigningFetchers } from "@/lib/execution/signGuard";
import { buildPaymentPlan } from "@/lib/execution/plan";
import { getToken } from "@/lib/config/tokens";
import type { Balance, Quote, QuoteResult } from "@/lib/domain/intent";

const SENDER = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;

const USDC = getToken("USDC")!;
const MON = getToken("MON")!;

function draft(overrides: Partial<ParsedPaymentIntent>): ParsedPaymentIntent {
  return { ...emptyIntent("mainnet"), ...overrides };
}

/**
 * The UI/state synchronisation contract. The composer, the chat and the quote
 * all read ONE canonical intent; these tests pin the mapping between the parsed
 * draft and that intent, and the guard that refuses to sign a payment the UI is
 * not actually showing.
 */
describe("NL draft → canonical intent mapping (single source of truth)", () => {
  it("maps a USD-value instruction to an amount, not a token quantity", () => {
    const patch = nlDraftToIntentPatch({
      draft: draft({ amount: "10", amountType: "USD_VALUE", asset: "MON" }),
    });
    expect(patch.receiveToken).toBe("MON");
    expect(patch.receiveAmount).toBe("10");
    expect(patch.receiveTokenAmount).toBeUndefined();
    expect(patch.amountMode).toBe("recipient_receives");
  });

  it("maps a token-quantity instruction to an exact token target", () => {
    const patch = nlDraftToIntentPatch({
      draft: draft({ amount: "10", amountType: "TOKEN_AMOUNT", asset: "MON" }),
    });
    expect(patch.receiveToken).toBe("MON");
    expect(patch.receiveTokenAmount).toBe("10");
    // The user named the source too ("10 MON" = spend MON).
    expect(patch.payToken).toBe("MON");
    expect(patch.payTokenSource).toBe("intent");
  });

  it("never guesses an asset for an unresolved ticker", () => {
    const patch = nlDraftToIntentPatch({
      draft: draft({ amount: "100", amountType: "TOKEN_AMOUNT", assetQuery: "NEWCOIN" }),
    });
    expect(patch.receiveToken).toBeUndefined();
    expect(patch.receiveTokenAddress).toBeUndefined();
    // The amount survives (it is a real token quantity) but the asset is left
    // for the user to pick — never borrowed from the default.
    expect(patch.receiveTokenAmount).toBe("100");
  });

  it("uses the live-resolved token for a named ticker", () => {
    const patch = nlDraftToIntentPatch({
      draft: draft({ amount: "100", amountType: "TOKEN_AMOUNT", assetQuery: "NEWCOIN" }),
      resolved: { symbol: "NEWCOIN", address: "0x9999999999999999999999999999999999999999" },
    });
    expect(patch.receiveToken).toBe("NEWCOIN");
    expect(patch.receiveTokenAddress).toBe("0x9999999999999999999999999999999999999999");
  });

  it("only ever sets a recipient from an explicit, valid address", () => {
    const named = nlDraftToIntentPatch({ draft: draft({ recipientName: "John" }) });
    expect(named.recipient).toBeUndefined();
    const addressed = nlDraftToIntentPatch({ draft: draft({ recipientAddress: RECIPIENT }) });
    expect(addressed.recipient).toBe(RECIPIENT);
  });

  it("leaves the amount untouched when the newest message carries none", () => {
    // A follow-up ("to 0x…" or an asset pick) must not clear the collected
    // amount: the patch simply omits it.
    const patch = nlDraftToIntentPatch({
      draft: draft({ asset: "MON", recipientAddress: RECIPIENT }),
    });
    expect(patch.receiveAmount).toBeUndefined();
    expect(patch.receiveToken).toBe("MON");
  });
});

describe("the exact contradictory-state bug (MON/missing vs USDC/$5)", () => {
  it("a MON instruction with no amount does NOT produce USDC/$5", () => {
    const base = initialIntent();
    const patch = nlDraftToIntentPatch({
      draft: draft({ asset: "MON" }),
    });
    const next = reduceIntent(base, patch);
    expect(next.receiveToken).toBe("MON");
    // No amount was stated, so none is invented — and certainly not USDC/5.
    expect(next.receiveAmount).toBe("");
    expect(next.receiveToken).not.toBe("USDC");
    expect(next.receiveAmount).not.toBe("5");
  });

  it("the starting intent is empty — there is no default payment", () => {
    const intent = initialIntent();
    expect(intent.receiveToken).toBe("");
    expect(intent.receiveAmount).toBe("");
    expect(intent.payToken).toBe("");
  });

  it("draftFromIntent reconstructs exactly what the canonical intent holds", () => {
    const intent = reduceIntent(initialIntent(), {
      receiveToken: "MON",
      receiveAmount: "10",
      recipient: RECIPIENT,
    });
    const d = draftFromIntent(intent, "mainnet");
    expect(d.asset).toBe("MON");
    expect(d.amount).toBe("10");
    expect(d.amountType).toBe("USD_VALUE");
    expect(d.recipientAddress).toBe(RECIPIENT);
    // An unresolved query is never reconstructed — it lives only in the newest
    // sentence, so the chat cannot claim an asset the intent does not hold.
    expect(d.assetQuery).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guard backstop: the payment on screen must be the one being signed.
// ---------------------------------------------------------------------------

function directQuote(intent: CanonicalIntent): Quote {
  return {
    intent: {
      recipient: intent.recipient,
      receiveToken: intent.receiveToken,
      receiveAmount: intent.receiveAmount,
      amountMode: intent.amountMode,
    },
    network: intent.network,
    payToken: USDC,
    receiveToken: USDC,
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
}

function completeIntent(overrides: Partial<CanonicalIntent> = {}): CanonicalIntent {
  return {
    ...reduceIntent(initialIntent(), {
      recipient: RECIPIENT,
      receiveToken: "USDC",
      receiveAmount: "5",
      payToken: "USDC",
      payTokenSource: "user",
    }),
    ...overrides,
  };
}

function fetchers(intent: CanonicalIntent, quote?: QuoteResult): SigningFetchers {
  return {
    fetchBalances: async (): Promise<Balance[]> => [
      { token: USDC, amount: "100", usd: 100 },
      { token: MON, amount: "1", usd: 0.03 },
    ],
    fetchQuote: async () => quote ?? { ok: true, quote: directQuote(intent) },
    resolveGas: async () => "native",
    readGas: async () => ({ gasLimit: 200_000n, gasPriceWei: 100_000_000_000n }),
    readIntent: () => intent,
    readAccount: () => SENDER,
  };
}

describe("signing guard refuses a payment the UI is not showing", () => {
  it("signs when the displayed fingerprint matches the canonical intent", async () => {
    const intent = completeIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, displayedKey: displayKey(intent) },
      fetchers(intent),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses when the displayed payment is a different asset (MON vs USDC)", async () => {
    const intent = completeIntent();
    const displayed = displayKey(completeIntent({ receiveToken: "MON" }));
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, displayedKey: displayed },
      fetchers(intent),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("composer_mismatch");
  });

  it("refuses when the displayed amount differs ($5 vs $10)", async () => {
    const intent = completeIntent();
    const displayed = displayKey(completeIntent({ receiveAmount: "10" }));
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, displayedKey: displayed },
      fetchers(intent),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("composer_mismatch");
  });

  it("refuses when the displayed recipient differs", async () => {
    const intent = completeIntent();
    const displayed = displayKey(completeIntent({ recipient: OTHER }));
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, displayedKey: displayed },
      fetchers(intent),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("composer_mismatch");
  });

  it("refuses when the displayed source asset differs", async () => {
    const intent = completeIntent();
    const displayed = displayKey(completeIntent({ payToken: "USDT" }));
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT, displayedKey: displayed },
      fetchers(intent),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("composer_mismatch");
  });

  it("is backward compatible when no displayed fingerprint is supplied", async () => {
    const intent = completeIntent();
    const result = await prepareSigning(
      { intent, sender: SENDER, recipient: RECIPIENT },
      fetchers(intent),
    );
    expect(result.ok).toBe(true);
  });
});

describe("displayKey changes for every execution-relevant field", () => {
  const base = completeIntent();
  const edits: Partial<CanonicalIntent>[] = [
    { receiveToken: "MON" },
    { receiveAmount: "25" },
    { payToken: "USDT" },
    { recipient: OTHER },
    { amountMode: "i_spend" },
  ];
  for (const edit of edits) {
    it(`differs after ${JSON.stringify(edit)}`, () => {
      expect(displayKey(completeIntent(edit))).not.toBe(displayKey(base));
    });
  }
  it("is stable for a provenance-only edit", () => {
    const retitled: CanonicalIntent = { ...base, text: "unchanged payment" };
    expect(displayKey(retitled)).toBe(displayKey(base));
  });
});

// A minimal sanity check that the plan the guard builds still carries an
// on-chain output bound (the MEV/slippage protection this flow depends on).
describe("the fresh plan still enforces an on-chain output bound", () => {
  it("builds an executable plan from the canonical intent", () => {
    const intent = completeIntent();
    const plan = buildPaymentPlan(directQuote(intent), SENDER, RECIPIENT);
    expect(plan.executable).toBe(true);
  });
});
