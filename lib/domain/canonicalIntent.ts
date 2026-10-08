import { isEvmAddress } from "@/lib/format";
import { getToken, getTokenByAddress } from "@/lib/config/tokens";
import type { AmountMode, PaymentIntent } from "@/lib/domain/intent";
import type { MonadNetwork } from "@/lib/config/chains";

/**
 * Canonical, versioned payment intent.
 *
 * This is the single source of truth for the whole flow. Every UI element reads
 * from it; nothing downstream keeps its own copy of a payment field. Every edit
 * that can change what the user would sign produces a new `version`, which is
 * how the rest of the system knows that any earlier quote, plan, review or
 * signature preparation is now invalid and must be discarded.
 *
 * It is deliberately pure (no React, no network) so the invalidation rules can
 * be unit-tested in isolation — the safety of the whole flow depends on them.
 */

/** Which asset the user is spending — the input to the payment. */
export type PayTokenSource = "user" | "intent" | "recommended";

/**
 * The fields that make up a payment request. A change to any of these changes
 * *what would be signed*, so each one bumps the intent version.
 */
export type CanonicalFields = {
  /** The raw natural-language instruction, kept verbatim as the user typed it. */
  text: string;
  /** Recipient address. Only ever an explicit 0x value — never inferred. */
  recipient: string;
  /** Output/receive asset symbol (what the recipient gets). Display only. */
  receiveToken: string;
  /**
   * The receive asset's contract address. This is the *authoritative* identity
   * (chain + address); the symbol is derived display metadata. Present whenever
   * the asset was chosen from the catalog.
   */
  receiveTokenAddress?: string;
  /** The amount as entered, interpreted per `amountMode`. */
  receiveAmount: string;
  /** Whether `receiveAmount` is "what they receive" or "what I spend". */
  amountMode: AmountMode;
  /**
   * The exact quantity of the receive token the recipient should get, in token
   * units, when the user named one ("send 100 NEWCOIN"). Present only for a
   * token-quantity intent. It drives the partial-balance split (how much is
   * already held vs. must be obtained) and the on-chain minimum, so it is
   * execution-relevant and part of the key.
   */
  receiveTokenAmount?: string;
  /** Source/pay asset symbol (what the user spends). Display only. */
  payToken: string;
  /** The pay asset's contract address — the authoritative identity. */
  payTokenAddress?: string;
  /** How the pay asset was established. */
  payTokenSource: PayTokenSource;
  /**
   * The asset that pays the NETWORK FEE. This is a distinct concept from the
   * payment source: a user may spend USDT for the payment while paying gas in
   * USDC. Absent means "not yet chosen" — never the same as the source by
   * default.
   */
  gasPaymentToken?: string;
  /** The gas asset's contract address — the authoritative identity. */
  gasPaymentTokenAddress?: string;
  /** How gas will be paid: native MON, or an ERC-20 through the paymaster. */
  gasPaymentMode?: "NATIVE" | "ERC20_PAYMASTER";
  /** Target chain. */
  network: MonadNetwork;
};

export type CanonicalIntent = CanonicalFields & {
  /** Monotonic version. Increments on every execution-relevant change. */
  version: number;
  /**
   * A stable fingerprint of the execution-relevant fields. Two intents with the
   * same key would produce the same transaction; the signing guard compares
   * this before and after fresh preparation to prove nothing drifted.
   */
  key: string;
};

/**
 * A patch to the intent. Every field is optional; a patch that changes no
 * execution-relevant field (e.g. a no-op) does not bump the version.
 */
export type IntentPatch = Partial<CanonicalFields>;

/**
 * The *empty* starting intent. Deliberately asset-less and amount-less: there is
 * no default payment. A previous build shipped `receiveToken: "USDC"` +
 * `receiveAmount: "5"`, which is exactly the "stale $5 USDC" that could appear
 * while the user had actually asked for MON with no amount. Nothing here may
 * ever overwrite what the user (or their parsed instruction) specified.
 */
export const DEFAULT_INTENT: CanonicalFields = {
  text: "",
  recipient: "",
  receiveToken: "",
  receiveAmount: "",
  amountMode: "recipient_receives",
  payToken: "",
  payTokenSource: "recommended",
  network: "mainnet",
};

export function initialIntent(): CanonicalIntent {
  return withMeta(DEFAULT_INTENT, 1);
}

/** True when an asset slot still needs the user (or the parser) to fill it. */
export function hasReceiveAsset(intent: CanonicalIntent): boolean {
  return Boolean(intent.receiveToken || intent.receiveTokenAddress);
}

/** True when `a` and `b` are the same request (ignoring version/key). */
function sameFields(a: CanonicalFields, b: CanonicalFields): boolean {
  return (
    a.text === b.text &&
    a.recipient === b.recipient &&
    a.receiveToken === b.receiveToken &&
    (a.receiveTokenAddress ?? "") === (b.receiveTokenAddress ?? "") &&
    a.receiveAmount === b.receiveAmount &&
    a.amountMode === b.amountMode &&
    (a.receiveTokenAmount ?? "") === (b.receiveTokenAmount ?? "") &&
    a.payToken === b.payToken &&
    (a.payTokenAddress ?? "") === (b.payTokenAddress ?? "") &&
    a.payTokenSource === b.payTokenSource &&
    (a.gasPaymentToken ?? "") === (b.gasPaymentToken ?? "") &&
    (a.gasPaymentTokenAddress ?? "") === (b.gasPaymentTokenAddress ?? "") &&
    (a.gasPaymentMode ?? "") === (b.gasPaymentMode ?? "") &&
    a.network === b.network
  );
}

/**
 * Fingerprint of the *execution-relevant* subset. `text` is excluded on
 * purpose: it is provenance, not an execution parameter. Two requests with the
 * same recipient/tokens/amount/network/mode produce the same transaction no
 * matter how they were phrased.
 *
 * The asset *addresses* are included (not just symbols) so that a same-symbol
 * token at a different contract — or a symbol that resolves differently after a
 * catalog refresh — produces a different key and therefore invalidates any
 * earlier quote/plan.
 */
export function executionKey(f: CanonicalFields): string {
  const assetRef = (symbol: string, address?: string) =>
    `${symbol.toLowerCase()}@${(address ?? "").toLowerCase()}`;
  return [
    f.network,
    f.amountMode,
    assetRef(f.receiveToken, f.receiveTokenAddress),
    f.receiveAmount,
    // The exact token quantity (when the user named one) decides how much is
    // split off as a direct transfer, so a change to it must invalidate.
    f.receiveTokenAmount ?? "",
    assetRef(f.payToken, f.payTokenAddress),
    f.recipient.toLowerCase(),
    // Gas payment is execution-relevant too: switching the gas token must
    // invalidate any earlier quote/plan. Appended last so existing key
    // structure is preserved.
    `${(f.gasPaymentToken ?? "").toLowerCase()}@${(f.gasPaymentTokenAddress ?? "").toLowerCase()}:${f.gasPaymentMode ?? ""}`,
  ].join("|");
}

/** Attach version + key to a set of fields. */
export function withMeta(f: CanonicalFields, version: number): CanonicalIntent {
  return { ...f, version, key: executionKey(f) };
}

/**
 * A symbol-level fingerprint of what the UI is *displaying*: the receive/pay
 * assets, the amounts, the mode and the recipient. It is deliberately
 * address-agnostic — contract identity is already enforced by `executionKey`
 * and the transaction plan; this fingerprint exists purely so the signing guard
 * can prove the payment on screen is the one it is about to sign.
 *
 * A composer that drifted from the canonical intent (the MON / USDC / $5 class
 * of bug) yields a different fingerprint and is refused before signing.
 */
export function displayKey(
  f: Pick<
    CanonicalFields,
    | "network"
    | "amountMode"
    | "receiveToken"
    | "receiveAmount"
    | "receiveTokenAmount"
    | "payToken"
    | "recipient"
    | "gasPaymentToken"
  >,
): string {
  return [
    f.network,
    f.amountMode,
    (f.receiveToken ?? "").toLowerCase(),
    f.receiveAmount ?? "",
    f.receiveTokenAmount ?? "",
    (f.payToken ?? "").toLowerCase(),
    (f.recipient ?? "").toLowerCase(),
    (f.gasPaymentToken ?? "").toLowerCase(),
  ].join("|");
}

/**
 * Apply a patch. The version increments only when an *execution-relevant* field
 * changed — i.e. when the resulting transaction would differ. Editing the raw
 * text or the provenance of the source asset (without changing the symbol) does
 * not bump the version, so it cannot needlessly invalidate an in-flight quote.
 */
export function reduceIntent(
  current: CanonicalIntent,
  patch: IntentPatch,
): CanonicalIntent {
  const next: CanonicalFields = { ...current, ...patch };
  if (sameFields(current, next)) return current;
  const keyChanged = executionKey(next) !== current.key;
  return withMeta(next, keyChanged ? current.version + 1 : current.version);
}

/** Extract the bare payment intent the quote/route layers consume. */
export function toPaymentIntent(intent: CanonicalIntent): PaymentIntent {
  return {
    recipient: intent.recipient,
    receiveToken: intent.receiveToken,
    receiveAmount: intent.receiveAmount,
    amountMode: intent.amountMode,
  };
}

/**
 * Resolve the canonical *receive* asset for this intent. The address is
 * authoritative; the symbol is a fallback only when no address was recorded.
 * Returns undefined when the intent's asset cannot be resolved at all — the UI
 * then shows "unknown", never a different token's label.
 */
export function receiveTokenOf(intent: CanonicalIntent) {
  return resolveIntentToken(intent.receiveTokenAddress, intent.receiveToken);
}

/** Resolve the canonical *pay* asset for this intent. */
export function payTokenOf(intent: CanonicalIntent) {
  return resolveIntentToken(intent.payTokenAddress, intent.payToken);
}

function resolveIntentToken(address: string | undefined, symbol: string) {
  if (address) {
    const byAddress = getTokenByAddress(address);
    if (byAddress) return byAddress;
  }
  if (symbol) {
    const bySymbol = getToken(symbol);
    if (bySymbol) return bySymbol;
  }
  return undefined;
}

/**
 * Fields that must be present and valid before a quote can even be requested.
 * The authoritative readiness gate still runs afterwards; this is only the
 * cheap precondition that decides whether to hit the network.
 */
export function isQuotable(intent: CanonicalIntent): boolean {
  return (
    isEvmAddress(intent.recipient.trim()) &&
    Boolean(intent.receiveAmount.trim()) &&
    Boolean(intent.receiveToken) &&
    Boolean(intent.payToken)
  );
}

/**
 * Reset the execution-specific fields a fresh intent must not inherit. A
 * payment's approval/quote/plan/hash/error are only ever valid for the exact
 * version that produced them; on any version change they are discarded.
 */
export type IntentDerived = {
  version: number;
  quote: unknown | null;
  plan: unknown | null;
  txHash: string | null;
  error: string | null;
};

/** True when previously-derived execution state still belongs to `intent`. */
export function isDerivedCurrent(
  derived: { version: number } | null | undefined,
  intent: CanonicalIntent,
): boolean {
  return Boolean(derived && derived.version === intent.version);
}
