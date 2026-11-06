import { describe, expect, it } from "vitest";

/**
 * RPC reliability regressions.
 *
 * The owner-reported failure was "a swap quote could not be recovered": a
 * rate-limited keyed RPC (Alchemy answered 429 with an empty body) made every
 * pool read fail, which the router reported as `route_unavailable` — a
 * *definitive* answer. The composer therefore cleared its last-known-good quote
 * and stopped retrying, and the user saw "no route" for a payment that was
 * fine a second earlier.
 *
 * Two invariants keep that from recurring:
 *   1. every RPC candidate list ends at the public Monad RPC, so a keyed
 *      endpoint that is down or throttled cannot make the app blind to Monad;
 *   2. an unreachable RPC is a transient `provider_error`, never a definitive
 *      `route_unavailable` (covered in `routeDiscovery.test.ts`).
 */

const ENV_KEYS = [
  "ALCHEMY_API_KEY",
  "MONAD_RPC_URL",
  "NEXT_PUBLIC_ALCHEMY_API_KEY",
  "NEXT_PUBLIC_MONAD_RPC_URL",
] as const;

async function withEnv<T>(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k] as string;
  }
  try {
    return await run();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  }
}

describe("RPC candidate lists always include a key-free fallback", () => {
  it("server list ends at the public RPC even with a keyed Alchemy endpoint configured", async () => {
    const { serverRpcUrls, PUBLIC_MONAD_RPC } = await import("@/lib/config/chains");
    await withEnv({ ALCHEMY_API_KEY: "test-key", MONAD_RPC_URL: undefined }, () => {
      const urls = serverRpcUrls();
      expect(urls[0]).toContain("monad-mainnet.g.alchemy.com");
      expect(urls).toContain(PUBLIC_MONAD_RPC);
      // The public node is the last resort, never dropped.
      expect(urls[urls.length - 1]).toBe(PUBLIC_MONAD_RPC);
    });
  });

  it("server list is never empty when nothing is configured", async () => {
    const { serverRpcUrls, PUBLIC_MONAD_RPC } = await import("@/lib/config/chains");
    await withEnv(
      {
        ALCHEMY_API_KEY: undefined,
        MONAD_RPC_URL: undefined,
        NEXT_PUBLIC_MONAD_RPC_URL: undefined,
      },
      () => {
        expect(serverRpcUrls()).toEqual([PUBLIC_MONAD_RPC]);
      },
    );
  });

  it("browser list ends at the public RPC and de-duplicates a repeated URL", async () => {
    const { browserRpcUrls, PUBLIC_MONAD_RPC } = await import("@/lib/config/chains");
    await withEnv(
      {
        NEXT_PUBLIC_ALCHEMY_API_KEY: "pub-key",
        NEXT_PUBLIC_MONAD_RPC_URL: PUBLIC_MONAD_RPC,
      },
      () => {
        const urls = browserRpcUrls();
        expect(urls[0]).toContain("monad-mainnet.g.alchemy.com");
        expect(urls).toContain(PUBLIC_MONAD_RPC);
        expect(urls[urls.length - 1]).toBe(PUBLIC_MONAD_RPC);
        // The configured public URL equals the built-in one: listed once.
        expect(urls.filter((u) => u === PUBLIC_MONAD_RPC)).toHaveLength(1);
      },
    );
  });
});

describe("the server client is built on a fallback transport", () => {
  it("uses a fallback transport over at least two endpoints", async () => {
    await withEnv({ ALCHEMY_API_KEY: "test-key", MONAD_RPC_URL: undefined }, async () => {
      const { serverRpcUrls } = await import("@/lib/config/chains");
      const { getPublicClient } = await import("@/lib/server/rpc");
      const client = getPublicClient("mainnet") as unknown as {
        transport: { type: string };
      };
      expect(client.transport.type).toBe("fallback");
      expect(serverRpcUrls().length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("isTransientQuoteError governs recovery", () => {
  it("treats an unreachable-provider failure as transient and a no-route as definitive", async () => {
    const { isTransientQuoteError } = await import("@/lib/domain/quoteState");
    expect(isTransientQuoteError("provider_error")).toBe(true);
    expect(isTransientQuoteError("quote_unavailable")).toBe(true);
    expect(isTransientQuoteError("route_unavailable")).toBe(false);
    expect(isTransientQuoteError("unsupported_token")).toBe(false);
  });
});

describe("a quote failure recovers instead of dead-ending", () => {
  type Q = { amount: string };
  const base: import("@/lib/domain/quoteState").QuoteSlot<Q> = {
    quote: null,
    quoteVersion: 0,
    autoRefreshAt: 0,
    quoteError: null,
    quoteRefreshFailedAt: 0,
  };

  it("keeps the last-known-good quote when a refresh fails transiently", async () => {
    const { applyQuoteFailure, shouldRetryQuote } = await import("@/lib/domain/quoteState");
    const held = { ...base, quote: { amount: "1" }, quoteVersion: 7, autoRefreshAt: 1000 };
    const next = applyQuoteFailure(held, {
      issuedVersion: 7,
      error: { code: "provider_error", message: "unreachable" },
      at: 2000,
    });
    expect(next.quote).toEqual({ amount: "1" });
    expect(next.quoteVersion).toBe(7);
    // The timestamp is preserved so staleness keeps ageing honestly.
    expect(next.autoRefreshAt).toBe(1000);
    expect(shouldRetryQuote(next)).toBe(true);
  });

  it("still retries a transient failure that arrived before any quote was held", async () => {
    const { applyQuoteFailure, shouldRetryQuote } = await import("@/lib/domain/quoteState");
    // This is the cold-quote case: no quote to keep, but the cause was
    // infrastructure, so the composer must not treat it as final.
    const next = applyQuoteFailure(base, {
      issuedVersion: 1,
      error: { code: "provider_error", message: "unreachable" },
      at: 2000,
    });
    expect(next.quote).toBeNull();
    expect(next.quoteError?.code).toBe("provider_error");
    expect(shouldRetryQuote(next)).toBe(true);
  });

  it("does not retry a definitive failure", async () => {
    const { applyQuoteFailure, shouldRetryQuote } = await import("@/lib/domain/quoteState");
    const next = applyQuoteFailure(base, {
      issuedVersion: 1,
      error: { code: "route_unavailable", message: "no route" },
      at: 2000,
    });
    expect(next.quoteError?.code).toBe("route_unavailable");
    expect(shouldRetryQuote(next)).toBe(false);
  });

  it("clears a stale quote on a definitive failure even if one was held", async () => {
    const { applyQuoteFailure } = await import("@/lib/domain/quoteState");
    const held = { ...base, quote: { amount: "1" }, quoteVersion: 7 };
    const next = applyQuoteFailure(held, {
      issuedVersion: 7,
      error: { code: "route_unavailable", message: "no route" },
      at: 2000,
    });
    expect(next.quote).toBeNull();
  });
});
