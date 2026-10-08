import { isEvmAddress } from "@/lib/format";
import {
  emptyIntent,
  sanitizePatch,
  type ParsedPaymentIntent,
} from "./schema";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * Deterministic natural-language parser.
 *
 * This is the *authority* for turning an English payment instruction into the
 * strict intent schema. It is rule-based, offline, side-effect free and always
 * available — so intent parsing keeps working even when the optional LLM is
 * down. An LLM may supply a *hint* afterwards (see `mergeHints`), but it can
 * never override a field the deterministic rules already extracted, and it can
 * never introduce a value the rules would reject.
 *
 * The three amount forms are deliberately distinct:
 *   "$10"              -> USD_VALUE,    asset null
 *   "10 MON"           -> TOKEN_AMOUNT, asset MON
 *   "$10 worth of MON" -> USD_VALUE,    asset MON
 */

export type ParseHint = {
  patch: unknown;
  source?: "llm";
};

export type ParseResult = {
  intent: ParsedPaymentIntent;
  /** Human-readable notes about what was understood (never financial claims). */
  understood: string[];
  /** Fields the deterministic rules could not resolve. */
  unresolved: string[];
};

/** Symbols the catalog knows — passed in so the parser never invents a token. */
export type ParserContext = {
  symbols: string[];
  network?: MonadNetwork;
};

export function parseIntent(text: string, ctx: ParserContext): ParsedPaymentIntent {
  return parseDetailed(text, ctx).intent;
}

/** Parse a plain-English payment instruction into the strict intent schema. */
export function parseDetailed(text: string, ctx: ParserContext): ParseResult {
  const network = ctx.network ?? "mainnet";
  const intent = emptyIntent(network);
  const understood: string[] = [];
  const unresolved: string[] = [];

  let s = (text ?? "").trim();
  if (!s) return { intent, understood, unresolved };

  // ---- Recipient address (explicit 0x only; never guessed from a name) ----
  const addrMatch = s.match(/0x[a-fA-F0-9]{40}/);
  if (addrMatch) {
    intent.recipientAddress = addrMatch[0];
    // Remove the address plus a preceding "to" so it can't become a name.
    s = s.replace(new RegExp(String.raw`\bto\s+${addrMatch[0]}`, "i"), " ");
    s = s.replace(addrMatch[0], " ");
  }

  // ---- "N A worth of B" (explicit source + target, amount in A) -----------
  const worthOf = extractSourceWorthOf(s, ctx.symbols);
  // ---- Explicit "$ amount worth of / in MON" (USD value + asset) ----------
  const valued = extractUsdWithAsset(s, ctx.symbols);
  // ---- USD value ("$10", "10 usd") ----------------------------------------
  const usd = extractUsd(s);
  // ---- Token amount ("10 MON") --------------------------------------------
  const tokenAmount = extractTokenAmount(s, ctx.symbols);
  // ---- Unknown ticker ("100 NEWCOIN") — a resolution request, not an asset -
  const unknown = extractUnknownSymbol(s, ctx.symbols);

  if (worthOf && Number(worthOf.amount) > 0) {
    // "100 USDC worth of MON": the amount is denominated in the source asset
    // (USDC); the recipient gets the target (MON). Both sides are made explicit.
    intent.amount = worthOf.amount;
    intent.amountType = "TOKEN_AMOUNT";
    intent.asset = worthOf.target;
    intent.sourceAsset = worthOf.source;
  } else if (valued && Number(valued.amount) > 0) {
    intent.amount = valued.amount;
    intent.amountType = "USD_VALUE";
    intent.asset = valued.symbol;
  } else if (usd && Number(usd.amount) > 0) {
    intent.amount = usd.amount;
    intent.amountType = "USD_VALUE";
    // "$10 USDC" (no "worth of") still names the asset.
    if (tokenAmount) intent.asset = tokenAmount.symbol;
  } else if (tokenAmount && Number(tokenAmount.amount) > 0) {
    intent.amount = tokenAmount.amount;
    intent.amountType = "TOKEN_AMOUNT";
    intent.asset = tokenAmount.symbol;
  } else if (unknown && Number(unknown.amount) > 0) {
    // A ticker the catalog does not know. Recorded as a *query* so the
    // discovery layer resolves it live (or asks the user to pick) — never
    // treated as a resolved asset.
    intent.amount = unknown.amount;
    intent.amountType = "TOKEN_AMOUNT";
    intent.assetQuery = unknown.symbol;
  }

  // Bare symbol with no quantity ("send MON to 0x…") — asset only.
  if (!intent.asset && !intent.assetQuery) {
    const bare = extractBareSymbol(s, ctx.symbols);
    if (bare) intent.asset = bare;
  }
  // A bare unknown ticker ("send NEWCOIN to 0x…") — a resolution request.
  if (!intent.asset && !intent.assetQuery) {
    const bareUnknown = extractBareUnknown(s, ctx.symbols);
    if (bareUnknown) intent.assetQuery = bareUnknown;
  }

  // ---- Recipient name (recorded as a name only; never an address) ---------
  const name = extractRecipientName(s, ctx.symbols);
  if (name) intent.recipientName = name;

  if (intent.amount) {
    understood.push(
      intent.amountType === "USD_VALUE"
        ? `$${intent.amount}`
        : `${intent.amount} ${intent.asset ?? "?"}`,
    );
  }
  if (intent.asset) understood.push(`asset ${intent.asset}`);
  if (intent.recipientAddress) understood.push(`recipient ${intent.recipientAddress}`);
  if (intent.recipientName) {
    understood.push(`name "${intent.recipientName}" — address still needed`);
  }
  return { intent, understood, unresolved };
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function extractUsd(s: string): { amount: string } | null {
  const m = s.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  if (m) return { amount: m[1].replace(/,/g, "") };
  const m2 = s.match(/\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:usd|dollars?|bucks?)\b/i);
  if (m2) return { amount: m2[1].replace(/,/g, "") };
  return null;
}

/** "$10 worth of MON" / "10 dollars in MON" / "$10 of MON". */
function extractUsdWithAsset(s: string, symbols: string[]): { amount: string; symbol: string } | null {
  const sym = symbolAlternation(symbols);
  if (!sym) return null;
  const m = s.match(
    new RegExp(
      String.raw`\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:worth\s+of|worth|of|in|into)\s+(${sym})\b`,
      "i",
    ),
  );
  if (m) return { amount: m[1].replace(/,/g, ""), symbol: canonical(m[2], symbols) };
  const m2 = s.match(
    new RegExp(
      String.raw`\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:usd|dollars?)\s*(?:worth\s+of|of|in|into)\s+(${sym})\b`,
      "i",
    ),
  );
  if (m2) return { amount: m2[1].replace(/,/g, ""), symbol: canonical(m2[2], symbols) };
  return null;
}

type AssetMatch = { symbol: string; amount: string };

/** Find "<number> <SYMBOL>", ignoring any $ so "$10 USDC" names USDC. */
function extractTokenAmount(s: string, symbols: string[]): AssetMatch | null {
  const sym = symbolAlternation(symbols);
  if (!sym) return null;
  const m = s.match(new RegExp(String.raw`\b([0-9][0-9,]*(?:\.[0-9]+)?)\s+(${sym})\b`, "i"));
  if (!m) return null;
  return { amount: m[1].replace(/,/g, ""), symbol: canonical(m[2], symbols) };
}

/**
 * "100 USDC worth of MON" / "100 USDC of MON" / "100 USDC into MON".
 *
 * Unlike the USD form, the amount is denominated in the *source* asset: the
 * user spends 100 USDC and the recipient receives MON. Both sides are returned
 * so the resulting intent can make the source and output explicit before any
 * execution. Only matched when both symbols are known.
 */
function extractSourceWorthOf(
  s: string,
  symbols: string[],
): { amount: string; source: string; target: string } | null {
  const sym = symbolAlternation(symbols);
  if (!sym) return null;
  const m = s.match(
    new RegExp(
      String.raw`\b([0-9][0-9,]*(?:\.[0-9]+)?)\s+(${sym})\s+(?:worth\s+of|worth|of|in|into)\s+(${sym})\b`,
      "i",
    ),
  );
  if (!m) return null;
  const source = canonical(m[2], symbols);
  const target = canonical(m[3], symbols);
  // A same-asset phrase ("100 USDC worth of USDC") is not a source/target pair.
  if (source.toLowerCase() === target.toLowerCase()) return null;
  return { amount: m[1].replace(/,/g, ""), source, target };
}

/** A symbol the user names without a quantity: "send MON to 0x…". */
function extractBareSymbol(s: string, symbols: string[]): string | null {
  const sym = symbolAlternation(symbols);
  if (!sym) return null;
  const m = new RegExp(String.raw`\b(${sym})\b`, "i").exec(s);
  return m ? canonical(m[1], symbols) : null;
}

// ---------------------------------------------------------------------------
// Unknown-ticker extraction (a *resolution request*, never a resolved asset)
//
// A token launched after deployment is not in `symbols`. When the user writes
// "Send 100 NEWCOIN to 0x…", we must not silently drop the asset and ask again;
// we record the ticker so the discovery layer can resolve it live. These
// patterns are deliberately conservative so an ordinary word ("Send 10 to 0x…")
// is never mistaken for a ticker.
// ---------------------------------------------------------------------------

/** Words that are never a ticker, even in a "<n> <WORD>" position. */
const NON_TICKER_WORDS = new Set([
  "usd", "usdc", "usdt", "usds", "dollars", "dollar", "bucks", "cents",
  "worth", "of", "in", "into", "to", "for", "from", "using", "with", "via",
  "the", "and", "or", "please", "send", "pay", "transfer", "give", "wire",
  "remit", "monad", "address", "wallet", "worth", "each", "per", "at",
]);

/** A plausible ticker: 2–20 chars, starts with a letter, no spaces. */
const TICKER_RE = /^[A-Za-z][A-Za-z0-9._-]{1,19}$/;

/** "100 NEWCOIN" / "100 newcoin" where NEWCOIN is not a known symbol. */
function extractUnknownSymbol(
  s: string,
  symbols: string[],
): { amount: string; symbol: string } | null {
  const known = new Set(symbols.map((x) => x.toLowerCase()));
  const re = /\b([0-9][0-9,]*(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9._-]{1,19})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const word = m[2];
    const lower = word.toLowerCase();
    if (known.has(lower) || NON_TICKER_WORDS.has(lower)) continue;
    if (!TICKER_RE.test(word)) continue;
    return { amount: m[1].replace(/,/g, ""), symbol: word };
  }
  return null;
}

/**
 * A bare unknown ticker after a payment verb: "send NEWCOIN to 0x…".
 *
 * Deliberately restricted to an ALL-CAPS token. A bare capitalised word after a
 * verb is far more likely a recipient name ("Send John $10") or a spelled-out
 * number ("Send ten dollars"), and mis-reading either as a ticker would be a
 * correctness bug. A real ticker in this position is conventionally all-caps.
 */
const BARE_TICKER_RE = /^[A-Z][A-Z0-9._-]{1,19}$/;

function extractBareUnknown(s: string, symbols: string[]): string | null {
  const known = new Set(symbols.map((x) => x.toLowerCase()));
  const m = s.match(/\b(?:send|pay|transfer|give|wire|remit)\s+(?:me\s+)?([A-Z][A-Z0-9._-]{1,19})\b/);
  if (!m) return null;
  const word = m[1];
  const lower = word.toLowerCase();
  if (known.has(lower) || NON_TICKER_WORDS.has(lower)) return null;
  if (!BARE_TICKER_RE.test(word)) return null;
  return word;
}

/**
 * Recipient-name extraction. Only a capitalised, non-reserved word introduced
 * by "to"/"for", or the token right after a payment verb. A name is recorded as
 * a *name only*; it never becomes an address.
 */
function extractRecipientName(s: string, symbols: string[]): string | null {
  const reserved = new Set([
    "monad", "usd", "dollar", "dollars", "bucks", "worth", "send", "pay", "transfer",
    "give", "wire", "remit", "the", "to", "for", "in", "of", "into", "using", "with",
    "address", "wallet",
    ...symbols.map((x) => x.toLowerCase()),
  ]);
  const clean = (w: string) => w.replace(/[^A-Za-z0-9._-]/g, "");

  const toName = s.match(/\b(?:to|for)\s+([A-Za-z][A-Za-z0-9._-]{1,39})\b/);
  if (toName && !reserved.has(toName[1].toLowerCase())) return clean(toName[1]);

  const verbName = s.match(
    /\b(?:send|pay|transfer|give|wire|remit)\s+([A-Za-z][A-Za-z0-9._-]{1,39})\b/i,
  );
  if (verbName && !reserved.has(verbName[1].toLowerCase())) return clean(verbName[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Symbol matching (never invents a token: only tokens in `symbols`)
// ---------------------------------------------------------------------------

function symbolAlternation(symbols: string[]): string | null {
  const list = [...new Set(symbols.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  // Longest-first so "USDC" wins over a shorter prefix; escape regex metachars.
  return list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function canonical(sym: string, symbols: string[]): string {
  return symbols.find((s) => s.toLowerCase() === sym.toLowerCase()) ?? sym;
}

// ---------------------------------------------------------------------------
// Optional LLM enhancement
// ---------------------------------------------------------------------------

/**
 * Merge an untrusted LLM patch into a deterministic result.
 *
 * Rules:
 *  - The deterministic parse always wins for any field it already filled.
 *  - The LLM may only fill *gaps*, with values that survive `sanitizePatch`.
 *  - Addresses, prices, routes and unknown fields are structurally impossible.
 */
export function mergeHints(
  base: ParsedPaymentIntent,
  hint: ParseHint,
  ctx: ParserContext,
): ParsedPaymentIntent {
  const patch = sanitizePatch(hint.patch, ctx.symbols);
  const merged: ParsedPaymentIntent = { ...base };
  if (!merged.amount && patch.amount) merged.amount = patch.amount;
  if (!merged.amountType && patch.amountType) merged.amountType = patch.amountType;
  if (!merged.asset && patch.asset) merged.asset = patch.asset;
  // The deterministic rules win for the target asset; the model may only name a
  // ticker to *resolve* when the rules found none.
  if (!merged.asset && !merged.assetQuery && patch.assetQuery) {
    merged.assetQuery = patch.assetQuery;
  }
  if (!merged.sourceAsset && patch.sourceAsset) merged.sourceAsset = patch.sourceAsset;
  if (!merged.recipientName && !merged.recipientAddress && patch.recipientName) {
    merged.recipientName = patch.recipientName;
  }
  return merged;
}

export { isEvmAddress };
