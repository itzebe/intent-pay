import { describe, expect, it } from "vitest";
import {
  isQuoteStale,
  shouldRefreshQuote,
  QUOTE_MAX_AGE_MS,
  QUOTE_REFRESH_AFTER_MS,
  QUOTE_RETRY_AFTER_MS,
} from "@/lib/domain/freshness";
import {
  applyQuoteFailure,
  applyQuoteSuccess,
  type QuoteSlot,
} from "@/lib/domain/quoteState";

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

  it("defines a retry backoff shorter than the refresh window", () => {
    expect(QUOTE_RETRY_AFTER_MS).toBeGreaterThan(0);
    expect(QUOTE_RETRY_AFTER_MS).toBeLessThan(QUOTE_REFRESH_AFTER_MS);
  });
});

/**
 * A failed quote *refresh* must never destroy the payment state. These pin the
 * rule that keeps a last-known-good quote alive across a transient provider
 * failure, and only clears it when there is nothing usable to keep.
 */
describe("quote refresh resilience", () => {
  type Q = { receiveAmount: string };
  const slot: QuoteSlot<Q> = {
    quote: { receiveAmount: "10" },
    quoteVersion: 3,
    autoRefreshAt: 1_000,
    quoteError: null,
    quoteRefreshFailedAt: 0,
  };

  it("keeps the last-known-good quote when a refresh for the same version fails", () => {
    const next = applyQuoteFailure(slot, {
      issuedVersion: 3,
      at: 5_000,
      error: { code: "provider_error", message: "routing service down" },
    });
    expect(next.quote).toEqual({ receiveAmount: "10" });
    expect(next.quoteVersion).toBe(3);
    // The original timestamp is kept so staleness keeps ageing honestly.
    expect(next.autoRefreshAt).toBe(1_000);
    expect(next.quoteError).toBeNull();
    // A retry is now scheduled.
    expect(next.quoteRefreshFailedAt).toBe(5_000);
  });

  it("clears the quote only when no usable quote exists for the version", () => {
    const empty: QuoteSlot<Q> = { ...slot, quote: null, quoteVersion: 0 };
    const next = applyQuoteFailure(empty, {
      issuedVersion: 3,
      at: 5_000,
      error: { code: "route_unavailable", message: "no route", alternatives: ["USDT"] },
    });
    expect(next.quote).toBeNull();
    expect(next.quoteError?.code).toBe("route_unavailable");
    expect(next.quoteError?.alternatives).toEqual(["USDT"]);
  });

  it("does not keep a quote that belongs to a superseded version", () => {
    // The held quote was for version 2; the failure is for version 3 — it is
    // stale state, so it must be dropped rather than shown for the new request.
    const next = applyQuoteFailure(slot, {
      issuedVersion: 4,
      at: 5_000,
      error: { code: "provider_error", message: "down" },
    });
    expect(next.quote).toBeNull();
    expect(next.quoteError?.code).toBe("provider_error");
  });

  it("surfaces a definitive failure even while a quote is held", () => {
    // A route that genuinely disappeared is a real state change, not an RPC
    // blip — it must not be masked by an endless refresh of a dead quote.
    const next = applyQuoteFailure(slot, {
      issuedVersion: 3,
      at: 5_000,
      error: { code: "route_unavailable", message: "no route now" },
    });
    expect(next.quote).toBeNull();
    expect(next.quoteError?.code).toBe("route_unavailable");
  });

  it("a successful refresh clears the error and the retry flag", () => {
    const failed = applyQuoteFailure(slot, {
      issuedVersion: 3,
      at: 5_000,
      error: { code: "provider_error", message: "down" },
    });
    const next = applyQuoteSuccess(failed, {
      quote: { receiveAmount: "11" },
      issuedVersion: 3,
      at: 6_000,
    });
    expect(next.quote).toEqual({ receiveAmount: "11" });
    expect(next.autoRefreshAt).toBe(6_000);
    expect(next.quoteError).toBeNull();
    expect(next.quoteRefreshFailedAt).toBe(0);
  });
});
