import { isEvmAddress } from "@/lib/format";
import { getToken } from "@/lib/config/tokens";
import type { AmountMode } from "@/lib/domain/intent";
import type { CanonicalIntent, IntentPatch } from "@/lib/domain/canonicalIntent";
import type { ParsedPaymentIntent } from "./schema";

/**
 * Map a parsed natural-language *draft* onto a patch of the canonical intent.
 *
 * This is the single bridge between the NL layer and the one canonical intent
 * store. It is pure and deterministic so it can be unit-tested without React or
 * a network, and so the composer's displayed state is *derived* from the draft
 * rather than maintained in a second, competing store.
 *
 * The mapping never invents a value:
 *   - a USD amount ("$10", "$10 worth of MON") maps straight to the canonical
 *     `receiveAmount` (USD) with mode `recipient_receives`;
 *   - a token quantity ("10 MON") keeps its exact target in
 *     `receiveTokenAmount` and, when the caller supplied the live USD value in
 *     `compose`, uses that; without a live price the USD amount stays empty so
 *     the composer shows the honest "missing" state instead of a fake number;
 *   - an unresolved ticker (`assetQuery`) is left for live resolution: this
 *     patch never guesses an asset for it.
 */
export type NlCompose = {
  /** USD value the recipient should receive — the composer's amount field. */
  receiveAmountUsd: string;
  amountMode: AmountMode;
  /** The token quantity the user named, when they named one. */
  tokenAmount?: string;
  /** The source asset the instruction deterministically fixes, when any. */
  sourceAsset?: string;
};

export type NlApplyInput = {
  draft: ParsedPaymentIntent;
  /** The live-resolved token for `draft.assetQuery`, when one resolved. */
  resolved?: { symbol: string; address: string } | null;
  /** The engine's live-price handoff, present only when complete + priced. */
  compose?: NlCompose | null;
};

export function nlDraftToIntentPatch(input: NlApplyInput): IntentPatch {
  const { draft, resolved, compose } = input;
  const patch: IntentPatch = {};

  // ---- Asset -------------------------------------------------------------
  // Prefer a concrete symbol the parser recognised; otherwise a live-resolved
  // token for the named ticker. An *unresolved* query (ambiguous / not found)
  // deliberately sets nothing — the user must pick, and we never guess.
  const symbol = draft.asset ?? resolved?.symbol ?? null;
  if (symbol) {
    patch.receiveToken = symbol;
    patch.receiveTokenAddress = resolved?.address ?? getToken(symbol)?.address;
  }

  // ---- Amount ------------------------------------------------------------
  // Only an *explicit* amount in the newest message changes the amount, so a
  // follow-up that carries no amount (an asset pick, an address answer) leaves
  // the collected amount in place — exactly the conversational contract the
  // server-side `mergeDraft` implements.
  if (compose) {
    patch.receiveAmount = compose.receiveAmountUsd;
    patch.amountMode = compose.amountMode;
    patch.receiveTokenAmount =
      draft.amountType === "TOKEN_AMOUNT" && !draft.sourceAsset ? compose.tokenAmount : undefined;
  } else if (draft.amount && draft.amountType === "USD_VALUE") {
    patch.receiveAmount = draft.amount;
    patch.amountMode = "recipient_receives";
    patch.receiveTokenAmount = undefined;
  } else if (draft.amount && draft.amountType === "TOKEN_AMOUNT") {
    // A token quantity with no live price yet: the canonical amount is
    // genuinely unknown, so it is cleared rather than fabricated. The exact
    // target is preserved for the partial split / on-chain minimum.
    patch.receiveAmount = "";
    patch.amountMode = "recipient_receives";
    patch.receiveTokenAmount = draft.amount;
  }

  // ---- Recipient ---------------------------------------------------------
  // Only an explicit, valid address is ever a recipient. A name is never
  // turned into one.
  if (isEvmAddress(draft.recipientAddress ?? "")) {
    patch.recipient = draft.recipientAddress!;
  }

  // ---- Source / pay asset ------------------------------------------------
  // Fixed only when the instruction determines it: the "N A worth of B" form
  // (`sourceAsset`) or a token-quantity instruction ("10 MON" — the user named
  // what they spend). A USD-value instruction ("$10 worth of MON") leaves the
  // source to the optimizer/user, so it is not set here.
  const fixedSource =
    compose?.sourceAsset ??
    (draft.sourceAsset ?? (draft.amountType === "TOKEN_AMOUNT" ? draft.asset : null));
  if (fixedSource) {
    patch.payToken = fixedSource;
    patch.payTokenAddress = getToken(fixedSource)?.address;
    patch.payTokenSource = "intent";
  }

  return patch;
}

/**
 * Reconstruct the NL *draft* from the canonical intent, for conversational
 * continuation. This is what removes the second state store: the draft the
 * engine sends back to the server is derived from the one canonical intent, so
 * the chat and the composer can never disagree about the collected fields.
 *
 * Only the fields the canonical intent genuinely holds are produced; an
 * unresolved ticker (which the intent never stores as an asset) is not
 * reconstructed, so it is re-derived from the newest sentence instead.
 */
export function draftFromIntent(intent: CanonicalIntent, network: ParsedPaymentIntent["network"]): ParsedPaymentIntent {
  const asset = intent.receiveToken || null;
  const amountType: ParsedPaymentIntent["amountType"] = intent.receiveTokenAmount
    ? "TOKEN_AMOUNT"
    : intent.receiveAmount
      ? "USD_VALUE"
      : null;
  return {
    amount: intent.receiveTokenAmount ?? (intent.receiveAmount || null),
    amountType,
    asset,
    assetQuery: null,
    sourceAsset: intent.payTokenSource === "intent" && intent.payToken !== asset ? intent.payToken : null,
    recipientAddress: isEvmAddress(intent.recipient) ? intent.recipient : null,
    recipientName: null,
    network,
    status: "incomplete",
  };
}
