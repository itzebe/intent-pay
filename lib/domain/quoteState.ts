/**
 * Quote-refresh resilience (pure).
 *
 * A quote is a point-in-time price. When it ages out we refresh it, and a
 * refresh can fail transiently (an RPC blip, a provider timeout). The rule this
 * module encodes: a failed *refresh* must never destroy the payment state.
 *
 * Concretely, when a refresh for the current intent version fails and we still
 * hold the last-known-good quote for that same version, we keep it (and its
 * timestamp, so staleness keeps ageing honestly) and record that a retry is due.
 * Only a failure with *no* usable quote for the current version clears the quote
 * and surfaces a blocking error. That is what stops a transient failure from
 * blanking the composer mid-payment.
 *
 * Kept pure (no React, no network) so the rule can be unit-tested directly.
 */

export type QuoteErrorView = {
  code: string;
  message: string;
  alternatives?: string[];
};

export type QuoteSlot<Q> = {
  quote: Q | null;
  /** The intent version the held quote was computed for. */
  quoteVersion: number;
  /** Wall-clock (ms) the held quote finished resolving. */
  autoRefreshAt: number;
  quoteError: QuoteErrorView | null;
  /** Wall-clock (ms) of the last failed refresh; 0 when none is pending. */
  quoteRefreshFailedAt: number;
};

export type QuoteFailure = { code: string; message: string; alternatives?: string[] };

/** True when `prev` still holds a usable quote for `issuedVersion`. */
export function hasUsableQuote<Q>(prev: QuoteSlot<Q>, issuedVersion: number): boolean {
  return Boolean(prev.quote) && prev.quoteVersion === issuedVersion;
}

/**
 * A *transient* failure is one where the provider could not be reached or did
 * not answer — an RPC blip or a timeout. Only these are worth keeping a
 * last-known-good quote across. A definitive answer (the route genuinely no
 * longer exists, the token is unsupported, the request was invalid) is a real
 * state change and must be surfaced, not masked by an endless refresh.
 */
export function isTransientQuoteError(code: string | null | undefined): boolean {
  switch (code) {
    case "provider_error":
    case "quote_unavailable":
      return true;
    default:
      return false;
  }
}

/**
 * Apply a refresh/initial-quote success. Clears any prior error and marks the
 * quote fresh; the retry flag is reset.
 */
export function applyQuoteSuccess<Q, T extends QuoteSlot<Q>>(
  prev: T,
  next: { quote: Q; issuedVersion: number; at: number },
): T {
  return {
    ...prev,
    quote: next.quote,
    quoteVersion: next.issuedVersion,
    autoRefreshAt: next.at,
    quoteError: null,
    quoteRefreshFailedAt: 0,
  };
}

/**
 * Apply a quote failure. A *transient* failure while the last-known-good quote
 * for the same version is still held keeps that quote (so the payment survives
 * an RPC blip) and requests a retry; a definitive failure, or one with nothing
 * usable to keep, clears the quote and surfaces the specific error.
 */
export function applyQuoteFailure<Q, T extends QuoteSlot<Q>>(
  prev: T,
  failure: { issuedVersion: number; error: QuoteFailure; at: number },
): T {
  if (isTransientQuoteError(failure.error.code) && hasUsableQuote(prev, failure.issuedVersion)) {
    return {
      ...prev,
      // Keep the quote AND its timestamp: the age keeps accruing so the UI can
      // still say "expired — refreshing", and the retry loop re-quotes.
      quote: prev.quote,
      quoteVersion: prev.quoteVersion,
      autoRefreshAt: prev.autoRefreshAt,
      quoteError: prev.quoteError,
      quoteRefreshFailedAt: failure.at,
    };
  }
  return {
    ...prev,
    quote: null,
    quoteVersion: 0,
    autoRefreshAt: 0,
    quoteError: {
      code: failure.error.code,
      message: failure.error.message,
      alternatives: failure.error.alternatives,
    },
    quoteRefreshFailedAt: failure.at,
  };
}
