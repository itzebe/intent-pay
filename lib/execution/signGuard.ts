import type { Address } from "viem";
import type { MonadNetwork } from "@/lib/config/chains";
import type { Balance, Quote, QuoteResult } from "@/lib/domain/intent";
import { parseUnits } from "@/lib/domain/math";
import { displayKey, type CanonicalIntent } from "@/lib/domain/canonicalIntent";
import { isQuoteStale } from "@/lib/domain/freshness";
import { assessPriceImpact, DEFAULT_SLIPPAGE_BPS } from "@/lib/domain/protection";
import { quoteGasReserveWei } from "@/lib/domain/gasReserve";
import { INSUFFICIENT_MON_FOR_FEES_MESSAGE } from "@/lib/domain/transactionError";
import { buildPaymentPlan, type PaymentPlan } from "./plan";

/**
 * How the network fee is paid. Intent Pay executes standard EOA transactions,
 * so gas is always paid in the native asset (MON).
 */
export type GasMode = "native";

/**
 * Signing safety pipeline.
 *
 * The single invariant that permits a signature:
 *
 *   CURRENT INTENT
 *   + FRESH LIVE DATA
 *   + FRESH TRANSACTION BUILD
 *   + MATCHING INTENT VERSION
 *   + VALID GAS STATE
 *
 * This module enforces it in code, not merely in the UI. Immediately before the
 * wallet is asked to sign, it:
 *   1. reads the current canonical intent and captures its version,
 *   2. fetches *fresh* balances, route/quote and gas state,
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
  /** Live gas-mode resolution (always native MON for the injected wallet). */
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
  /**
   * Fingerprint of the payment the *UI is displaying* (the receive/pay assets,
   * amounts, mode and recipient). When supplied, the guard refuses to sign
   * unless it equals `displayKey(ctx.intent)` — so a composer that ever drifts
   * from the canonical intent (the MON/USDC/$5 class of bug) can never be
   * signed, even if the UI regression reappears.
   */
  displayedKey?: string;
};

/**
 * A freshly-built execution plan plus the quotes it was built from. A partial
 * ("send what you hold + convert the rest") payment has two legs and therefore
 * two quotes; a normal payment has one. Returning the set lets the guard apply
 * freshness, price-impact and balance checks uniformly.
 */
export type FreshPlan = {
  plan: PaymentPlan;
  /** Every quote the plan was constructed from (all must be fresh). */
  quotes: Quote[];
  /** The token the recipient receives. */
  receiveToken: string;
  /** The total the recipient should receive across all legs. */
  expectedReceive: string;
};

export type SigningFetchers = {
  /** Read the wallet's current balances from the chain. */
  fetchBalances: () => Promise<FreshBalances>;
  /** Re-run the full quote/route/pricing pipeline for the intent. */
  fetchQuote: (intent: CanonicalIntent) => Promise<QuoteResult>;
  /**
   * Optional: build the fresh plan directly (used for a partial-balance split,
   * where the plan has two legs and one quote is not enough). When present it
   * replaces `fetchQuote` + `buildPaymentPlan`, but every downstream protection
   * check still runs. Returning `{ ok: false }` blocks signing.
   */
  fetchPlan?: (
    intent: CanonicalIntent,
    balances: Balance[],
  ) => Promise<{ ok: true; fresh: FreshPlan } | { ok: false; reason: SigningAbortReason }>;
  /**
   * Optional: coverage check for the built plan. A split plan is covered only
   * when the wallet funds *both* legs, so the default single-quote check is not
   * sufficient.
   */
  covers?: (balances: Balance[], plan: PaymentPlan) => boolean;
  /**
   * Resolve gas eligibility against the connected wallet right now. Gas is
   * always paid in MON, so this always returns "native"; it stays a fetcher so
   * the guard re-checks it live rather than trusting a captured value.
   */
  resolveGas: () => Promise<GasMode>;
  /**
   * The live gas estimate, used to check the wallet can still pay the network
   * fee in MON. Optional: when absent we do not fabricate a fee.
   */
  readGas?: () => Promise<{ gasLimit?: bigint; gasPriceWei?: bigint }>;
  /** The canonical intent as it stands *now* (re-read after fetching). */
  readIntent: () => CanonicalIntent;
  /**
   * The wallet account as it stands *now*. If it differs from the account the
   * payment was prepared for, the signature is aborted: balances, allowances
   * and gas state all belong to the old account.
   */
  readAccount: () => Address | undefined;
  /** Injectable clock for deterministic staleness tests. */
  now?: () => number;
};

export type SigningPlan = {
  ok: true;
  plan: PaymentPlan;
  quote: Quote;
  /** The token the recipient receives (a split plan may have two quotes). */
  receiveToken: string;
  /** The total the recipient should receive across all legs. */
  expectedReceive: string;
  /** A partial-balance split was used (held + converted shortfall). */
  partial: boolean;
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
  | "composer_mismatch"
  | "not_ready";

const BLOCKED_MESSAGES: Record<SigningAbortReason, string> = {
  intent_changed: "This payment changed while it was being prepared. Review the new request and try again.",
  quote_unavailable: "We couldn't get a fresh quote just now. Please try again.",
  quote_stale: "The price moved. We refreshed it — review the new price and confirm again.",
  intent_mismatch: "The prepared transaction no longer matches your request. Please review it again.",
  insufficient_balance: "Your balance changed and no longer covers this payment. Review it again.",
  insufficient_gas: INSUFFICIENT_MON_FOR_FEES_MESSAGE,
  account_changed: "Your wallet account changed. Balances and gas were rebuilt for the new account — review and confirm again.",
  price_impact:
    "This route's price impact is too high to execute safely. Slippage is never widened to force it — choose a different amount or payment asset.",
  unprotected:
    "This transaction could not be built with an on-chain output bound, so it was not signed. Please try again.",
  composer_mismatch:
    "The payment on screen doesn't match the current request, so it was not signed. Please review the payment again.",
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

  // 0. The payment the UI is showing must be the canonical intent we are about
  // to sign. This is the architectural backstop against a composer that drifts
  // from the one source of truth: if the displayed fingerprint differs from the
  // canonical intent's own fingerprint, we refuse to sign rather than sign the
  // wrong thing.
  if (ctx.displayedKey !== undefined && ctx.displayedKey !== displayKey(ctx.intent)) {
    return {
      ok: false,
      reason: "composer_mismatch",
      message: BLOCKED_MESSAGES.composer_mismatch,
      expectedVersion,
      actualVersion: expectedVersion,
    };
  }

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

  // 1 + 2. Fresh balances and a fresh plan/quote. A partial payment supplies
  // `fetchPlan` (two legs) and needs the fresh balances to know how much is
  // held; otherwise we quote then build. Both run before the intent re-read.
  const balances = await fetchers.fetchBalances().catch(() => [] as FreshBalances);
  const freshResult = fetchers.fetchPlan
    ? await fetchers.fetchPlan(ctx.intent, balances)
    : await fetchers.fetchQuote(ctx.intent).then((r) =>
        r.ok
          ? ({
              ok: true as const,
              fresh: {
                plan: buildPaymentPlan(
                  r.quote,
                  ctx.sender,
                  ctx.recipient,
                  ctx.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
                ),
                quotes: [r.quote],
                receiveToken: r.quote.receiveToken.symbol,
                expectedReceive: r.quote.receiveAmount,
              },
            })
          : ({ ok: false as const, reason: "quote_unavailable" as const }),
      );

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
  // mid-preparation invalidates balances, allowances and gas state — so it
  // aborts rather than signs for the wrong account.
  const account = fetchers.readAccount();
  if (!account || account.toLowerCase() !== ctx.sender.toLowerCase()) {
    return block("account_changed", current.version);
  }

  if (!freshResult.ok) return block(freshResult.reason, current.version);
  const { plan, quotes, receiveToken, expectedReceive } = freshResult.fresh;
  const quote = quotes[0];

  // 4. Every fresh quote must be inside its freshness window. A quote that is
  // already stale when it comes back means the market is moving too fast to
  // safely sign. A split plan has two quotes; both must be fresh.
  if (quotes.some((q) => isQuoteStale(q.quotedAt, now()))) {
    return block("quote_stale", current.version);
  }

  // 5. Every quote must actually describe the current intent — the route layer
  // echoes the intent it priced, so a mismatch is a hard stop. A split plan's
  // legs are sub-amounts of the intent (the direct leg's pay == receive == the
  // target), so for a split we verify the parameters that decide *where* money
  // goes — recipient, receive token, network — rather than each leg's amount.
  const partial = Boolean(fetchers.fetchPlan);
  for (const q of quotes) {
    const ok = partial
      ? quoteMatchesIntentPartial(q, current)
      : quoteMatchesIntent(q, current);
    if (!ok) return block("intent_mismatch", current.version);
  }

  // 5b. A route whose live price impact exceeds the configured ceiling is
  // blocked *before signing*. Slippage is never widened to make a bad route
  // execute; an unknown impact does not block (we never invent one).
  if (quotes.some((q) => assessPriceImpact(q.priceImpact).blocked)) {
    return block("price_impact", current.version);
  }

  // 6. The fresh balances must still cover the fresh plan. A balance that
  // drained between review and signing must block, not sign. A split plan is
  // covered only when the wallet funds *both* legs, so it supplies its own check.
  const covered = fetchers.covers
    ? fetchers.covers(balances, plan)
    : coversBalance(balances, quote);
  if (!covered) return block("insufficient_balance", current.version);

  // 7. Gas eligibility is resolved live: the fee is always paid in MON.
  const gasMode = await fetchers.resolveGas();

  // 8. The wallet must still be able to pay the network fee in MON. Losing the
  // ability to cover the fee between review and signing blocks — we never widen
  // anything to force the transaction through.
  if (gasMode === "native") {
    const gas = fetchers.readGas
      ? await fetchers.readGas().catch(() => ({ gasLimit: undefined, gasPriceWei: undefined }))
      : {};
    if (!coversGas(balances, gas.gasLimit, gas.gasPriceWei)) {
      return block("insufficient_gas", current.version);
    }
  }

  // 9. The plan must be executable, and every executable swap must carry a real
  // on-chain bound. A swap step that could be signed with no minimum output is
  // refused here — the UI's "Minimum received" figure is never the protection.
  if (!plan.executable) return block("not_ready", current.version);
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
    receiveToken,
    expectedReceive,
    partial: Boolean(fetchers.fetchPlan),
    gasMode,
    version: final.version,
    key: final.key,
  };
}

/**
 * True when the fresh balances still cover the fresh quote's pay amount. A
 * native MON source must also keep its own network fee aside — the reserve is
 * the quote's `gasLimit × maxFeePerGas`, not a flat amount, so a small native
 * payment is only blocked when it genuinely cannot cover its fee. A missing
 * balance entry is treated as unknown rather than insufficient, so a wallet we
 * couldn't read does not spuriously block — the execution layer will surface a
 * real shortfall.
 */
export function coversBalance(balances: Balance[], quote: Quote): boolean {
  const pay = balances.find((b) => b.token.symbol === quote.payToken.symbol);
  if (!pay) return true;
  try {
    const required = parseUnits(quote.payAmount, quote.payToken.decimals);
    const reserve = quote.payToken.native ? quoteGasReserveWei(quote) : 0n;
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
 * The subset of the match that a split plan's leg must satisfy: where the money
 * goes (recipient), what the recipient gets (receive token), and on which chain.
 * A leg's amount is a sub-amount of the intent by construction, and the direct
 * leg's pay token is the target itself, so neither is compared here. The
 * authoritative amount check for a split is the plan's own on-chain bounds.
 */
export function quoteMatchesIntentPartial(quote: Quote, intent: CanonicalIntent): boolean {
  const q = quote.intent;
  return (
    q.recipient.trim().toLowerCase() === intent.recipient.trim().toLowerCase() &&
    q.receiveToken === intent.receiveToken &&
    quote.receiveToken.symbol === intent.receiveToken &&
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

export type { MonadNetwork };
