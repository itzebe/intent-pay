import { describe, expect, it } from "vitest";
import { sanitizeUpstreamError } from "@/lib/server/http";

/**
 * Provider-error sanitisation.
 *
 * An upstream failure message must never leak the configured RPC endpoint —
 * viem's `HttpRequestError` embeds the full request URL, including an
 * API-key-in-path, and these messages are returned inside API error bodies.
 */
describe("sanitizeUpstreamError", () => {
  it("strips an API key carried in an RPC URL path but keeps the origin", () => {
    const viemish =
      "HTTP request failed.\n\nStatus: 429\nURL: https://monad-mainnet.g.alchemy.com/v2/alch_SUPERSECRET123\n\nVersion: viem@2.57.3";
    const out = sanitizeUpstreamError(new Error(viemish), "fallback");
    expect(out).not.toContain("alch_SUPERSECRET123");
    expect(out).not.toContain("/v2/");
    expect(out).toContain("https://monad-mainnet.g.alchemy.com");
  });

  it("strips credentials from a userinfo URL", () => {
    const out = sanitizeUpstreamError(
      new Error("request to https://user:pass@rpc.example.com/path failed"),
      "fallback",
    );
    expect(out).not.toContain("user:pass");
    expect(out).toContain("https://rpc.example.com");
  });

  it("truncates a very long message and never returns a stack trace", () => {
    const long = `Error: ${"x".repeat(500)}`;
    const out = sanitizeUpstreamError(new Error(long), "fallback");
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back when the error carries no usable message", () => {
    expect(sanitizeUpstreamError(undefined, "Could not build a quote.")).toBe(
      "Could not build a quote.",
    );
    expect(sanitizeUpstreamError({}, "Could not build a quote.")).toBe(
      "Could not build a quote.",
    );
    expect(sanitizeUpstreamError(new Error("   "), "Could not build a quote.")).toBe(
      "Could not build a quote.",
    );
  });

  it("leaves a plain message with no URL unchanged", () => {
    expect(sanitizeUpstreamError(new Error("No route for this pair"), "fallback")).toBe(
      "No route for this pair",
    );
  });
});
