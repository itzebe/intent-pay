import type { MonadNetwork } from "@/lib/config/chains";
import { isEvmAddress } from "@/lib/format";

/**
 * Natural-language Intent Engine — strict schema + state machine.
 *
 * The AI/NLU layer only ever produces a *draft* of the fields below. It never
 * produces prices, routes, calldata, or a transaction. The deterministic state
 * machine decides what is still missing; the existing payment infrastructure
 * decides how the money actually moves.
 *
 * This file is intentionally dependency-free (no React, no network) so the
 * state machine can be unit-tested in isolation.
 */

/** Whether the parsed amount is a dollar value or a token quantity. */
export type AmountType = "USD_VALUE" | "TOKEN_AMOUNT";

/**
 * Conversational state. Derived *only* from the structured draft, never from
 * LLM memory, so a dropped/restarted model can never skip a required field.
 */
export type IntentState =
  | "NEEDS_AMOUNT"
  | "NEEDS_ASSET"
  | "NEEDS_RECIPIENT"
  | "READY_FOR_QUOTE"
  | "READY_FOR_REVIEW"
  | "AWAITING_USER_APPROVAL"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED";

/** Lifecycle status mirrored onto the draft. */
export type IntentStatus =
  | "incomplete"
  | "ready"
  | "quoted"
  | "reviewing"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed";

/**
 * The strict payment intent the parser produces.
 * Every field is nullable until the user supplies it — nothing is guessed.
 */
export type ParsedPaymentIntent = {
  /** Decimal string, e.g. "10" or "5.50". */
  amount: string | null;
  amountType: AmountType | null;
  /** Receive-asset *symbol* (e.g. "MON"), resolved against the catalog. */
  asset: string | null;
  /**
   * An asset the user named by ticker/name that is *not* in the catalog yet.
   * It is a resolution *request*, not an asset: the discovery layer attempts to
   * resolve it live and, when several tokens share the symbol/name, asks the
   * user to pick rather than guessing. Never treated as a resolved asset.
   */
  assetQuery: string | null;
  /**
   * An explicit *source* asset, for the "X A worth of B" form: the user fixes
   * both what they spend (A) and what the recipient gets (B). Present only when
   * the user named both sides; otherwise the source is the normal recommendation.
   */
  sourceAsset: string | null;
  /** A wallet address the user typed. Only ever an explicit 0x address. */
  recipientAddress: string | null;
  /** A human name the user typed (e.g. "John"). Never turned into an address. */
  recipientName: string | null;
  network: MonadNetwork;
  status: IntentStatus;
};

export function emptyIntent(network: MonadNetwork = "mainnet"): ParsedPaymentIntent {
  return {
    amount: null,
    amountType: null,
    asset: null,
    assetQuery: null,
    sourceAsset: null,
    recipientAddress: null,
    recipientName: null,
    network,
    status: "incomplete",
  };
}

/** Which required field is still missing, in the order we must collect them. */
export type MissingField = "amount" | "asset" | "recipient" | null;

export function missingField(intent: ParsedPaymentIntent): MissingField {
  if (!intent.amount || !intent.amountType) return "amount";
  // An `assetQuery` (a ticker the user named that isn't catalogued yet) fills
  // the asset slot at the *parser* level: the user has told us what they want,
  // so we resolve it live rather than asking "which asset?" again. Resolution
  // failure or ambiguity is surfaced by the discovery layer, not as a question.
  if (!intent.asset && !intent.assetQuery) return "asset";
  // A name without an address is *not* a resolved recipient. We never guess an
  // address from a name, so the address is the only thing that clears this.
  if (!isEvmAddress(intent.recipientAddress ?? "")) return "recipient";
  return null;
}

/**
 * Derive the conversational state from the structured draft. Pure and total:
 * the same draft always yields the same state.
 */
export function deriveState(intent: ParsedPaymentIntent): IntentState {
  const missing = missingField(intent);
  if (missing === "amount") return "NEEDS_AMOUNT";
  if (missing === "asset") return "NEEDS_ASSET";
  if (missing === "recipient") return "NEEDS_RECIPIENT";

  switch (intent.status) {
    case "quoted":
      return "READY_FOR_REVIEW";
    case "reviewing":
      return "READY_FOR_REVIEW";
    case "awaiting_approval":
      return "AWAITING_USER_APPROVAL";
    case "executing":
      return "EXECUTING";
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    default:
      // Fully specified but not yet quoted — the quote layer runs next.
      return "READY_FOR_QUOTE";
  }
}

/** True once the draft contains everything needed to build a quote. */
export function isComplete(intent: ParsedPaymentIntent): boolean {
  return missingField(intent) === null;
}

// ---------------------------------------------------------------------------
// Strict runtime validation of untrusted (LLM) output
//
// The LLM may only *fill NLU fields*. It must never be able to smuggle in a
// price, a route, a contract address, or a transaction — those fields simply do
// not exist on this type, and anything unknown is dropped.
// ---------------------------------------------------------------------------

export type IntentPatch = Partial<{
  amount: string;
  amountType: AmountType;
  asset: string;
  assetQuery: string;
  sourceAsset: string;
  recipientName: string;
}>;

const ALLOWED_KEYS = new Set([
  "amount",
  "amountType",
  "asset",
  "assetQuery",
  "sourceAsset",
  "recipientName",
]);

/** A plausible ticker/name token: 1–20 chars, starts with a letter. */
const TICKER_RE = /^[A-Za-z][A-Za-z0-9._-]{0,19}$/;

function isPositiveDecimalString(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const n = Number(v.replace(/,/g, ""));
  return /^\d{1,18}(\.\d{1,18})?$/.test(v.trim()) && Number.isFinite(n) && n > 0;
}

/**
 * Validate an untrusted patch. Returns only the fields that are well-formed;
 * everything else (unknown keys, bad types, addresses, prices, routes) is
 * discarded. `knownSymbols` gates asset names so the model can't invent a token.
 */
export function sanitizePatch(raw: unknown, knownSymbols: Iterable<string>): IntentPatch {
  if (!raw || typeof raw !== "object") return {};
  const symbols = new Set([...knownSymbols].map((s) => s.toLowerCase()));
  const out: IntentPatch = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (k === "amount" && isPositiveDecimalString(v)) out.amount = v.replace(/,/g, "");
    if (k === "amountType" && (v === "USD_VALUE" || v === "TOKEN_AMOUNT")) out.amountType = v;
    if (k === "asset" && typeof v === "string" && symbols.has(v.trim().toLowerCase())) {
      out.asset = v.trim();
    }
    // `assetQuery`/`sourceAsset` are resolution *requests*: the LLM may name a
    // ticker we don't know (that is the point), so they are validated as
    // well-formed tickers, not against the known-symbol set. They can never
    // carry an address, price, or route — those keys are not on this type.
    if (k === "assetQuery" && typeof v === "string" && TICKER_RE.test(v.trim())) {
      out.assetQuery = v.trim();
    }
    if (k === "sourceAsset" && typeof v === "string" && TICKER_RE.test(v.trim())) {
      out.sourceAsset = v.trim();
    }
    if (
      k === "recipientName" &&
      typeof v === "string" &&
      /^[A-Za-z][A-Za-z0-9._-]{0,39}$/.test(v.trim())
    ) {
      out.recipientName = v.trim();
    }
  }
  return out;
}
