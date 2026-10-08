import type { MonadNetwork } from "@/lib/config/chains";
import { isEvmAddress } from "@/lib/format";
import { mergeHints, parseDetailed, type ParseHint } from "./parser";
import { nextClarification, type Clarification } from "./question";
import {
  deriveState,
  sanitizePatch,
  type IntentState,
  type ParsedPaymentIntent,
} from "./schema";

/**
 * Intent Engine orchestration (pure).
 *
 * Turns a sentence into a strict draft + the next clarification. Combines the
 * deterministic parser with an optional, strictly-validated LLM hint. Contains
 * no I/O so it can be unit-tested and reused on both server and client.
 */
export type NlpPlan = {
  state: IntentState;
  draft: ParsedPaymentIntent;
  clarification: Clarification;
  understood: string[];
  /** True when an LLM hint was applied (deterministic rules still won). */
  llmUsed: boolean;
};

export type PlanInput = {
  symbols: string[];
  network?: MonadNetwork;
  /** Optional untrusted LLM patch. Gaps only; never overrides the parser. */
  hint?: ParseHint | null;
};

export function planFromText(text: string, input: PlanInput): NlpPlan {
  const ctx = { symbols: input.symbols, network: input.network };
  const parsed = parseDetailed(text, ctx);

  let draft = parsed.intent;
  let llmUsed = false;
  if (input.hint) {
    const merged = mergeHints(draft, input.hint, ctx);
    llmUsed = merged !== draft || hasPatch(input.hint, input.symbols);
    draft = merged;
  }

  return {
    state: deriveState(draft),
    draft,
    clarification: nextClarification(draft),
    understood: parsed.understood,
    llmUsed,
  };
}

/** Re-derive the plan (state + question) from a draft that was updated in place. */
export function planFromDraft(draft: ParsedPaymentIntent): NlpPlan {
  return {
    state: deriveState(draft),
    draft,
    clarification: nextClarification(draft),
    understood: [],
    llmUsed: false,
  };
}

/**
 * Merge the newest parsed message into the collected draft.
 *
 * The newest message's explicit values win, so restating an amount, asset, or
 * address corrects the draft instead of being silently ignored. A message that
 * carries none of those (an asset pick, an address answer, a bare follow-up)
 * leaves the previously collected fields in place.
 */
export function mergeDraft(
  active: ParsedPaymentIntent,
  parsed: ParsedPaymentIntent,
): ParsedPaymentIntent {
  const next: ParsedPaymentIntent = { ...active };
  if (parsed.amount) {
    next.amount = parsed.amount;
    next.amountType = parsed.amountType;
  }
  // A newly-named asset replaces a previously unresolved query, and vice versa:
  // naming a concrete symbol clears the pending resolution request.
  if (parsed.asset) {
    next.asset = parsed.asset;
    next.assetQuery = null;
  }
  if (parsed.assetQuery && !parsed.asset) {
    next.assetQuery = parsed.assetQuery;
    next.asset = null;
  }
  if (parsed.sourceAsset) next.sourceAsset = parsed.sourceAsset;
  if (parsed.recipientAddress) next.recipientAddress = parsed.recipientAddress;
  if (parsed.recipientName) next.recipientName = parsed.recipientName;
  return next;
}

/**
 * Record the outcome of resolving an `assetQuery`: set the concrete asset and
 * clear the pending query. The symbol is validated against the known set, so a
 * resolution can only ever produce a token the catalog recognises.
 */
export function applyResolvedAsset(
  draft: ParsedPaymentIntent,
  symbol: string,
  symbols: string[],
): ParsedPaymentIntent {
  const patch = sanitizePatch({ asset: symbol }, symbols);
  if (!patch.asset) return draft;
  const next: ParsedPaymentIntent = { ...draft, asset: patch.asset, assetQuery: null };
  return { ...next, status: statusFor(next) };
}

/** Record a ticker the user named that still needs live resolution. */
export function applyAssetQuery(
  draft: ParsedPaymentIntent,
  query: string,
): ParsedPaymentIntent {
  const patch = sanitizePatch({ assetQuery: query }, []);
  if (!patch.assetQuery) return draft;
  return { ...draft, asset: null, assetQuery: patch.assetQuery };
}

/** Apply a user's asset choice to the draft (validated against known symbols). */
export function applyAsset(
  draft: ParsedPaymentIntent,
  symbol: string,
  symbols: string[],
): ParsedPaymentIntent {
  const patch = sanitizePatch({ asset: symbol }, symbols);
  if (!patch.asset) return draft;
  return { ...draft, asset: patch.asset, status: statusFor({ ...draft, asset: patch.asset }) };
}

/** Apply a user-typed recipient address to the draft. Never guessed. */
export function applyAddress(
  draft: ParsedPaymentIntent,
  address: string,
): ParsedPaymentIntent {
  const value = (address ?? "").trim();
  if (!isEvmAddress(value)) return draft;
  const next = { ...draft, recipientAddress: value };
  return { ...next, status: statusFor(next) };
}

/** Apply a user-typed amount to the draft. */
export function applyAmount(
  draft: ParsedPaymentIntent,
  amount: string,
  amountType: "USD_VALUE" | "TOKEN_AMOUNT",
): ParsedPaymentIntent {
  const patch = sanitizePatch({ amount, amountType }, draft.asset ? [draft.asset] : []);
  if (!patch.amount || !patch.amountType) return draft;
  const next = { ...draft, amount: patch.amount, amountType: patch.amountType };
  return { ...next, status: statusFor(next) };
}

/** Status to mirror onto the draft as fields are filled in. */
function statusFor(draft: ParsedPaymentIntent): ParsedPaymentIntent["status"] {
  if (!draft.amount || !draft.amountType) return "incomplete";
  if (!draft.asset && !draft.assetQuery) return "incomplete";
  if (!isEvmAddress(draft.recipientAddress ?? "")) return "incomplete";
  return "ready";
}

function hasPatch(hint: ParseHint, symbols: string[]): boolean {
  return Object.keys(sanitizePatch(hint.patch, symbols)).length > 0;
}
