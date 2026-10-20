import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAttempt, reportAttempt, attemptIdempotencyKey } from "@/lib/payments/attempts";

/**
 * Payment-attempt correlation is telemetry layered on top of the payment flow.
 * It must never become a failure mode of its own: no hanging request may sit
 * between the user and their wallet, and a retry must reuse one attempt.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("beginAttempt bounds the wallet-blocking window", () => {
  it("returns null (and does not hang) when the request never resolves", async () => {
    // A fetch that ignores its AbortSignal would hang forever; the point of the
    // bound is that a compliant fetch is aborted and the caller is released.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) return reject(new Error("aborted"));
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    vi.useFakeTimers();
    const promise = beginAttempt(
      { intentKey: "k", idempotencyKey: "idem" },
      { timeoutMs: 50 },
    );
    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).resolves.toBeNull();
  });

  it("returns null on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));
    await expect(beginAttempt({ intentKey: "k" })).resolves.toBeNull();
  });

  it("returns the id on a valid response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, id: "abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(beginAttempt({ intentKey: "k" })).resolves.toBe("abc");
  });
});

describe("reportAttempt never throws", () => {
  it("is a no-op without an id", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(reportAttempt(null, "submitted")).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("swallows a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("down");
    }));
    await expect(reportAttempt("id", "submitted")).resolves.toBeUndefined();
  });
});

describe("attemptIdempotencyKey", () => {
  const base = {
    network: "mainnet" as const,
    amountMode: "recipient_receives" as const,
    receiveToken: "USDC",
    receiveAmount: "5",
    receiveTokenAmount: null,
    payToken: "USDT",
    recipient: "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4",
    payTokenAddress: null,
    version: 3,
  };

  it("is stable for the same account + intent", () => {
    const a = attemptIdempotencyKey("0xABC", base as never);
    const b = attemptIdempotencyKey("0xabc", base as never);
    expect(a).toBe(b);
  });

  it("changes when the intent version changes", () => {
    const a = attemptIdempotencyKey("0xabc", base as never);
    const b = attemptIdempotencyKey("0xabc", { ...base, version: 4 } as never);
    expect(a).not.toBe(b);
  });
});
