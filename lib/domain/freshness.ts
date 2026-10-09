/**
 * Quote freshness.
 *
 * An execution quote is a point-in-time price. It is only safe to sign for a
 * short window; after that the market may have moved and the amount the user
 * approved is no longer the amount they would get. We refresh shortly before a
 * quote expires, and treat a quote older than the hard max as stale so it can
 * never be executed.
 *
 * Kept in a client-safe module (no server imports) so both the server quote
 * layer and the browser composer share exactly one definition of "stale".
 */

/** A quote older than this is stale and must not be executed. */
export const QUOTE_MAX_AGE_MS = 20_000;

/** We proactively refresh the quote this long after it was produced. */
export const QUOTE_REFRESH_AFTER_MS = 15_000;

/**
 * How long to wait before retrying a quote refresh that failed. A failed
 * refresh keeps the last-known-good quote (see `lib/domain/quoteState`), so this
 * is a recovery backoff — short enough to recover quickly, long enough never to
 * hammer a struggling provider.
 */
export const QUOTE_RETRY_AFTER_MS = 4_000;

/** True when a quote produced at `quotedAt` is too old to execute at `now`. */
export function isQuoteStale(
  quotedAt: number | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = QUOTE_MAX_AGE_MS,
): boolean {
  if (!quotedAt) return false;
  return now - quotedAt > maxAgeMs;
}

/** True when a quote is approaching staleness and should be refreshed. */
export function shouldRefreshQuote(
  quotedAt: number | null | undefined,
  now: number = Date.now(),
  refreshAfterMs: number = QUOTE_REFRESH_AFTER_MS,
): boolean {
  if (!quotedAt) return false;
  return now - quotedAt >= refreshAfterMs;
}
