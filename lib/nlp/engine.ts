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
  const complete =
    Boolean(draft.amount && draft.amountType) &&
    Boolean(draft.asset) &&
    isEvmAddress(draft.recipientAddress ?? "");
  if (!draft.amount || !draft.amountType) return "incomplete";
  if (!draft.asset) return "incomplete";
  if (!isEvmAddress(draft.recipientAddress ?? "")) return "incomplete";
  return complete ? "ready" : "incomplete";
}

function hasPatch(hint: ParseHint, symbols: string[]): boolean {
  return Object.keys(sanitizePatch(hint.patch, symbols)).length > 0;
}
