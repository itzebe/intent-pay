import type { Address } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import type { Balance, Quote, QuoteResult } from "@/lib/domain/intent";
import { parseUnits } from "@/lib/domain/math";
import type { CanonicalIntent } from "@/lib/domain/canonicalIntent";
import { isQuoteStale } from "@/lib/domain/freshness";
import { assessPriceImpact, DEFAULT_SLIPPAGE_BPS } from "@/lib/domain/protection";
import { buildPaymentPlan, type PaymentPlan } from "./plan";
import { resolveGasMode, type GasMode } from "./alchemy";

/**
 * Signing safety pipeline.
 *
 * The single invariant that permits a signature:
 *
 *   CURRENT INTENT
 *   + FRESH LIVE DATA
 *   + FRESH TRANSACTION BUILD
 *   + MATCHING INTENT VERSION
 *   + VALID PAYMASTER/GAS STATE
 *
 * This module enforces it in code, not merely in the UI. Immediately before the
 * wallet is asked to sign, it:
 *   1. reads the current canonical intent and captures its version,
 *   2. fetches *fresh* balances, route/quote and gas/paymaster state,
 *   3. rebuilds the transaction plan from those fresh values,
 *   4. re-reads the intent version and confirms it did not change mid-preparation,
 *   5. confirms the fresh quote is still within its freshness window,
 *   6. confirms every execution parameter still matches the current intent,
 *   and only then returns the plan to sign.
 *
 * If anything changed it returns `{ ok: false }` with a specific reason; the
 * caller must NOT sign and must rebuild the intent from the new state.
 *
 * The fetchers are injected so the whole pipeline is testable against real
 * fixtures without a browser wallet or a live network.
 */

export type FreshBalances = Balance[];

/** The fresh live data gathered immediately before signing. */
export type FreshData = {
  balances: FreshBalances;
  quote: Quote;
  /** Live gas-mode resolution (paymaster eligibility + wallet capability). */
  gasMode: GasMode;
};

export type SigningContext = {
  intent: CanonicalIntent;
  sender: Address;
  recipient: Address;
  /**
   * Slippage tolerance (bps) to encode into the on-chain swap bound. Clamped by
   * `lib/domain/protection`; never widened in response to price impact.
   */
  slippageBps?: number;
};

export type SigningFetchers = {
  /** Read the wallet's current balances from the chain. */
  fetchBalances: () => Promise<FreshBalances>;
  /** Re-run the full quote/route/pricing pipeline for the intent. */
  fetchQuote: (intent: CanonicalIntent) => Promise<QuoteResult>;
  /**
   * Re-resolve paymaster/gas eligibility against the connected wallet right
   * now. Returns the mode the wallet can actually deliver.
   */
  resolveGas: () => Promise<GasMode>;
  /**
   * The live MON price and a current gas estimate, used to check the wallet can
   * still pay the fee in MON when sponsorship is unavailable. Optional: when
   * absent we do not fabricate a fee.
   */
  readGas?: () => Promise<{ gasLimit?: bigint; gasPriceWei?: bigint }>;
  /** The canonical intent as it stands *now* (re-read after fetching). */
  readIntent: () => CanonicalIntent;
  /**
   * The wallet account as it stands *now*. If it differs from the account the
   * payment was prepared for, the signature is aborted: balances, allowances,
   * smart-account state and the paymaster payload all belong to the old account.
   */
  readAccount: () => Address | undefined;
  /** Injectable clock for deterministic staleness tests. */
  now?: () => number;
};

export type SigningPlan = {
  ok: true;
  plan: PaymentPlan;
  quote: Quote;
  gasMode: GasMode;
  version: number;
  key: string;
};

export type SigningBlocked = {
  ok: false;
  reason: SigningAbortReason;
  message: string;
  /** The version at the moment preparation started. */
  expectedVersion: number;
  /** The version the intent actually held when we finished. */
  actualVersion: number;
};

export type SigningAbortReason =
  | "intent_changed"
  | "quote_unavailable"
  | "quote_stale"
  | "intent_mismatch"
  | "insufficient_balance"
  | "insufficient_gas"
  | "account_changed"
  | "price_impact"
  | "unprotected"
  | "not_ready";

const BLOCKED_MESSAGES: Record<SigningAbortReason, string> = {
  intent_changed: "This payment changed while it was being prepared. Review the new request and try again.",
  quote_unavailable: "We couldn't get a fresh quote just now. Please try again.",
  quote_stale: "The price moved. We refreshed it — review the new price and confirm again.",
  intent_mismatch: "The prepared transaction no longer matches your request. Please review it again.",
  insufficient_balance: "Your balance changed and no longer covers this payment. Review it again.",
  insufficient_gas: "Gas can no longer be sponsored and your wallet doesn't hold enough MON for the fee. Review the payment again.",
  account_changed: "Your wallet account changed. Balances and gas were rebuilt for the new account — review and confirm again.",
  price_impact:
    "This route's price impact is too high to execute safely. Slippage is never widened to force it — choose a different amount or payment asset.",
  unprotected:
    "This transaction could not be built with an on-chain output bound, so it was not signed. Please try again.",
  not_ready: "This payment isn't ready to sign yet.",
};

/**
 * Run the signing safety pipeline. Returns a freshly-built plan only when every
 * condition of the invariant holds.
 */
export async function prepareSigning(
  ctx: SigningContext,
  fetchers: SigningFetchers,
): Promise<SigningPlan | SigningBlocked> {
  const expectedVersion = ctx.intent.version;
  const expectedKey = ctx.intent.key;
  const now = fetchers.now ?? (() => Date.now());

  const block = (
    reason: SigningAbortReason,
    actualVersion = expectedVersion,
  ): SigningBlocked => ({
    ok: false,
    reason,
    message: BLOCKED_MESSAGES[reason],
    expectedVersion,
    actualVersion,
  });

  // 1 + 2. Fresh balances and a fresh quote, concurrently with the re-read of
  // the current intent.
  const [balances, quoteResult] = await Promise.all([
    fetchers.fetchBalances().catch(() => [] as FreshBalances),
    fetchers.fetchQuote(ctx.intent),
  ]);

  // 3. Re-read the intent *after* the network round-trips. If the user edited
  // anything while we were fetching, this is a different request.
  const current = fetchers.readIntent();
  if (current.version !== expectedVersion) {
    return block("intent_changed", current.version);
  }
  if (current.key !== expectedKey) {
    return block("intent_mismatch", current.version);
  }

  // The wallet account must be the one this payment was prepared for. A switch
  // mid-preparation invalidates balances, allowances, smart-account state and
  // the paymaster payload — so it aborts rather than signs for the wrong account.
  const account = fetchers.readAccount();
  if (!account || account.toLowerCase() !== ctx.sender.toLowerCase()) {
    return block("account_changed", current.version);
  }

  if (!quoteResult.ok) return block("quote_unavailable", current.version);
  const quote = quoteResult.quote;

  // 4. The fresh quote must be inside its freshness window. A quote that is
  // already stale when it comes back means the market is moving too fast to
  // safely sign.
  if (isQuoteStale(quote.quotedAt, now())) return block("quote_stale", current.version);

  // 5. The quote must actually describe the current intent — the route layer
  // echoes the intent it priced, so a mismatch is a hard stop.
  if (!quoteMatchesIntent(quote, current)) return block("intent_mismatch", current.version);

  // 5b. A route whose live price impact exceeds the configured ceiling is
  // blocked *before signing*. Slippage is never widened to make a bad route
  // execute; an unknown impact does not block (we never invent one).
  if (assessPriceImpact(quote.priceImpact).blocked) {
    return block("price_impact", current.version);
  }

  // 6. The fresh balances must still cover the fresh quote. A balance that
  // drained between review and signing must block, not sign.
  if (!coversBalance(balances, quote)) return block("insufficient_balance", current.version);

  // 7. Paymaster/gas eligibility is resolved live, against the connected wallet.
  const gasMode = await fetchers.resolveGas();

  // 8. If gas is no longer abstracted, the wallet must still hold enough MON to
  // pay the fee. Losing sponsorship between review and signing must block.
  if (gasMode === "native") {
    const gas = fetchers.readGas
      ? await fetchers.readGas().catch(() => ({ gasLimit: undefined, gasPriceWei: undefined }))
      : {};
    if (!coversGas(balances, gas.gasLimit, gas.gasPriceWei)) {
      return block("insufficient_gas", current.version);
    }
  }

  // 9. Rebuild the transaction plan from the *fresh* quote, with the clamped
  // slippage bound. Calldata is never reused from an earlier build.
  let plan: PaymentPlan;
  try {
    plan = buildPaymentPlan(quote, ctx.sender, ctx.recipient, ctx.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  } catch {
    return block("quote_unavailable", current.version);
  }
  if (!plan.executable) return block("not_ready", current.version);

  // 9b. Every executable swap must carry a real on-chain bound. A swap step
  // that could be signed with no minimum output is refused here — the UI's
  // "Minimum received" figure is never the protection.
  if (!planHasOutputBound(plan)) return block("unprotected", current.version);

  // 10. Final re-read: a change that landed during plan construction also aborts.
  const final = fetchers.readIntent();
  if (final.version !== expectedVersion || final.key !== expectedKey) {
    return block("intent_changed", final.version);
  }
  const finalAccount = fetchers.readAccount();
  if (!finalAccount || finalAccount.toLowerCase() !== ctx.sender.toLowerCase()) {
    return block("account_changed", final.version);
  }

  return {
    ok: true,
    plan,
    quote,
    gasMode,
    version: final.version,
    key: final.key,
  };
}

/**
 * True when the fresh balances still cover the fresh quote's pay amount (with a
 * small native reserve for gas). A missing balance entry is treated as unknown
 * rather than insufficient, so a wallet we couldn't read does not spuriously
 * block — the execution layer will surface a real shortfall.
 */
export function coversBalance(balances: Balance[], quote: Quote): boolean {
  const pay = balances.find((b) => b.token.symbol === quote.payToken.symbol);
  if (!pay) return true;
  try {
    const required = parseUnits(quote.payAmount, quote.payToken.decimals);
    const reserve = quote.payToken.native ? 10_000_000_000_000_000n : 0n;
    const available = parseUnits(pay.amount, quote.payToken.decimals);
    return available >= required + reserve;
  } catch {
    return true;
  }
}

/**
 * True when the wallet holds enough MON to cover the fee. Unknown inputs (no
 * native entry, no gas estimate) do not block — we never fabricate a fee to
 * block on.
 */
export function coversGas(
  balances: Balance[],
  gasLimit?: bigint,
  gasPriceWei?: bigint,
): boolean {
  // An empty set means the balances could not be read at all — unknown, so we
  // do not block on it.
  if (balances.length === 0) return true;
  const native = balances.find((b) => b.token.native);
  // Balances were read but no native entry exists: the wallet holds no MON.
  if (!native) return false;
  if (!gasLimit || !gasPriceWei) return true;
  try {
    const required = gasLimit * gasPriceWei;
    const buffered = required + required / 5n;
    const available = parseUnits(native.amount, 18);
    return available >= buffered;
  } catch {
    return true;
  }
}

/**
 * Confirm a quote describes exactly the intent it is about to execute. Checks
 * the recipient, both tokens, the amount semantics and the network — the
 * parameters that decide where money goes and how much.
 */
export function quoteMatchesIntent(quote: Quote, intent: CanonicalIntent): boolean {
  const q = quote.intent;
  return (
    q.recipient.trim().toLowerCase() === intent.recipient.trim().toLowerCase() &&
    q.receiveToken === intent.receiveToken &&
    q.receiveAmount === intent.receiveAmount &&
    q.amountMode === intent.amountMode &&
    quote.payToken.symbol === intent.payToken &&
    quote.network === intent.network
  );
}

/**
 * True when every swap step in an executable plan carries a real on-chain
 * output bound: `amountOutMinimum > 0` for an exact-input swap, or
 * `amountInMaximum > 0` for an exact-output swap. A plan with a swap that has
 * no bound would let a sandwich fill at any price, so it must never be signed.
 *
 * Non-swap plans (direct transfers) carry no swap and trivially satisfy this.
 *
 * NOTE: SwapRouter02 on Monad has no `deadline` parameter, so there is no
 * on-chain time bound to assert here. Quote freshness is enforced off-chain, by
 * `prepareSigning` refusing a stale quote and rebuilding the calldata.
 */
export function planHasOutputBound(plan: PaymentPlan): boolean {
  for (const step of plan.steps) {
    if (step.kind !== "swap") continue;
    if (step.direction === "exact_in") {
      if (!(step.amountOutMinimum && step.amountOutMinimum > 0n)) return false;
    } else {
      if (!(step.amountInMaximum && step.amountInMaximum > 0n)) return false;
    }
  }
  return true;
}

/**
 * A stable fingerprint of a built transaction, derived from the plan's own
 * encoded calls. Two builds of the same intent with the same live data produce
 * the same fingerprint; a changed amount, route or recipient produces a
 * different one. Used to prove a transaction was built for the current intent.
 */
export function planFingerprint(
  plan: PaymentPlan,
  encode: (step: PaymentPlan["steps"][number]) => unknown,
): string {
  const parts = plan.steps.map((s) => JSON.stringify(encode(s), bigIntReplacer));
  return parts.join(";");
}

/** JSON replacer so bigint step amounts serialise deterministically. */
function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export { resolveGasMode };
export type { MonadNetwork };
