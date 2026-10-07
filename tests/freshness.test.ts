import { describe, expect, it } from "vitest";
import {
  isQuoteStale,
  shouldRefreshQuote,
  QUOTE_MAX_AGE_MS,
  QUOTE_REFRESH_AFTER_MS,
} from "@/lib/domain/freshness";

/**
 * Quote staleness is the guard that stops a user signing a price they saw
 * minutes ago. These lock the boundary behaviour both the server quote layer
 * and the composer rely on.
 */
describe("quote freshness", () => {
  const now = 1_000_000;

  it("a freshly produced quote is not stale", () => {
    expect(isQuoteStale(now - 1_000, now)).toBe(false);
  });

  it("a quote is not stale exactly at the boundary, but is just past it", () => {
    expect(isQuoteStale(now - QUOTE_MAX_AGE_MS, now)).toBe(false);
    expect(isQuoteStale(now - QUOTE_MAX_AGE_MS - 1, now)).toBe(true);
  });

  it("never reports NULL as stale (no quote yet)", () => {
    expect(isQuoteStale(null, now)).toBe(false);
    expect(isQuoteStale(undefined, now)).toBe(false);
    expect(isQuoteStale(0, now)).toBe(false);
  });

  it("schedules a proactive refresh before the hard stale limit", () => {
    expect(QUOTE_REFRESH_AFTER_MS).toBeLessThan(QUOTE_MAX_AGE_MS);
    expect(shouldRefreshQuote(now - QUOTE_REFRESH_AFTER_MS, now)).toBe(true);
    expect(shouldRefreshQuote(now - QUOTE_REFRESH_AFTER_MS + 1, now)).toBe(false);
  });
});
