import { isEvmAddress } from "@/lib/format";
import type { AmountMode } from "@/lib/domain/intent";
import type { ParsedPaymentIntent } from "./schema";

/**
 * Handoff from a completed NL draft to the *existing* payment composer.
 *
 * The composer is USD-denominated ("recipient receives $X of TOKEN"), so a
 * token-amount intent ("10 MON") is converted to its live USD value here — and
 * only here. This function is pure: the caller supplies the live price, so the
 * engine never invents a financial value.
 *
 * The requested output asset is authoritative: this never substitutes a
 * different asset the sender happens to hold. Obtaining an asset the sender
 * doesn't hold is the existing routing/optimizer layer's job.
 */
export type ComposeHandoff = {
  recipient: string;
  receiveToken: string;
  /** USD value the recipient should receive — the composer's amount field. */
  receiveAmountUsd: string;
  amountMode: AmountMode;
  /** The token quantity the user asked for, when they named one. */
  tokenAmount?: string;
  /**
   * The source asset the user's instruction deterministically fixes, when it
   * does. "Send 10 MON" fixes the source to MON; a USD-value intent
   * ("$10 worth of MON") does not, so the source stays the user's choice.
   */
  sourceAsset?: string;
  /** How the source was established — mirrors the composer's payTokenSource. */
  sourceOrigin?: "intent";
};

export type HandoffResult =
  | { ok: true; compose: ComposeHandoff; summary: string }
  | { ok: false; reason: "incomplete" | "price_unavailable"; message: string };

/** Trim a float to a stable decimal string without scientific notation. */
function toDecimalString(value: number, maxFrac = 6): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return value
    .toFixed(maxFrac)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

export function draftToHandoff(
  draft: ParsedPaymentIntent,
  priceUsd: number | null,
): HandoffResult {
  if (
    !draft.amount ||
    !draft.amountType ||
    !draft.asset ||
    !isEvmAddress(draft.recipientAddress ?? "")
  ) {
    return { ok: false, reason: "incomplete", message: "The payment intent isn't complete yet." };
  }

  if (draft.amountType === "USD_VALUE") {
    const usd = toDecimalString(Number(draft.amount));
    const tokenAmount =
      priceUsd && priceUsd > 0
        ? toDecimalString(Number(draft.amount) / priceUsd, 6)
        : undefined;
    return {
      ok: true,
      compose: {
        recipient: draft.recipientAddress!,
        receiveToken: draft.asset,
        receiveAmountUsd: usd,
        amountMode: "recipient_receives",
        tokenAmount,
      },
      summary: `$${draft.amount} in ${draft.asset}`,
    };
  }

  // TOKEN_AMOUNT: needs a live price to express as USD. Without one we refuse
  // rather than fabricate a value.
  if (!(priceUsd && priceUsd > 0)) {
    return {
      ok: false,
      reason: "price_unavailable",
      message: `We can't find a live price for ${draft.asset}, so this payment can't be prepared.`,
    };
  }
  const usd = Number(draft.amount) * priceUsd;
  return {
    ok: true,
    compose: {
      recipient: draft.recipientAddress!,
      receiveToken: draft.asset,
      receiveAmountUsd: toDecimalString(usd),
      amountMode: "recipient_receives",
      tokenAmount: draft.amount,
      // A token-quantity instruction ("10 MON") fixes the *source* asset too:
      // the user named what they want to spend, so we must not later suggest a
      // different asset to pay with.
      sourceAsset: draft.asset,
      sourceOrigin: "intent",
    },
    summary: `${draft.amount} ${draft.asset}`,
  };
}
