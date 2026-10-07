import { describe, expect, it } from "vitest";
import { computeReadiness, isPaymentReady, type ReadinessInput } from "@/lib/domain/readiness";

const RECIPIENT = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";

/** A fully valid, ready payment — the baseline each case perturbs. */
function readyInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    recipient: RECIPIENT,
    recipientConfirmed: true,
    payTokenIsSet: true,
    payToken: "USDC",
    receiveToken: "MON",
    quoting: false,
    quote: { route: { kind: "swap", path: ["USDC", "MON"] }, payAmount: "10", receiveAmount: "388" },
    quoteError: null,
    quoteStale: false,
    sufficiency: { status: "ok" },
    gasSufficiency: { status: "ok", requiredMon: "0.01" },
    mismatchActive: false,
    ...overrides,
  };
}

describe("payment readiness gate", () => {
  it("is ready only when every execution input is finalized", () => {
    expect(isPaymentReady(readyInput())).toBe(true);
    expect(computeReadiness(readyInput()).code).toBe("ready");
  });

  it("blocks an invalid or missing recipient", () => {
    expect(computeReadiness(readyInput({ recipient: "" })).code).toBe("invalid_recipient");
    expect(computeReadiness(readyInput({ recipient: "0xnope" })).code).toBe("invalid_recipient");
    expect(isPaymentReady(readyInput({ recipient: "0xnope" }))).toBe(false);
  });

  it("requires the recipient address to be explicitly confirmed (never guessed from a name)", () => {
    // A name like "John" leaves the address unconfirmed; the flow must ask for
    // a real address and cannot proceed on the name alone.
    const r = computeReadiness(readyInput({ recipientConfirmed: false }));
    expect(r.ready).toBe(false);
    expect(r.code).toBe("invalid_recipient");
    expect(r.cta).toMatch(/Confirm recipient/i);
  });

  it("never proceeds while the source asset is merely recommended", () => {
    // The optimizer may hold a suggestion, but only an explicit user choice or
    // an intent-fixed source clears the gate — we never silently pick one.
    const r = computeReadiness(readyInput({ payTokenIsSet: false }));
    expect(r.ready).toBe(false);
    expect(r.code).toBe("choose_payment_asset");
  });

  it("blocks an over-delivery mismatch (exact-payment protection)", () => {
    expect(computeReadiness(readyInput({ mismatchActive: true })).code).toBe("amount_mismatch");
  });

  it("is not ready while a quote is in flight", () => {
    expect(computeReadiness(readyInput({ quoting: true })).code).toBe("quoting");
  });

  it("blocks a stale quote with a retryable, refreshing state", () => {
    const r = computeReadiness(readyInput({ quoteStale: true }));
    expect(r.code).toBe("quote_stale");
    expect(r.retryable).toBe(true);
  });

  it("maps a route failure to an actionable 'no route' state", () => {
    const r = computeReadiness(
      readyInput({
        quote: null,
        quoteError: { code: "route_unavailable", message: "no liquidity" },
      }),
    );
    expect(r.code).toBe("no_route");
    expect(r.severity).toBe("error");
    expect(r.cta).toMatch(/No route/i);
  });

  it("blocks a wallet that cannot cover the payment or the network fee", () => {
    expect(
      computeReadiness(readyInput({ sufficiency: { status: "insufficient", required: "10", available: "2" } }))
        .code,
    ).toBe("insufficient_balance");
    expect(
      computeReadiness(readyInput({ gasSufficiency: { status: "insufficient", requiredMon: "0.1" } })).code,
    ).toBe("insufficient_gas");
  });

  it("treats an unfinished quote (no amounts) as an incomplete amount", () => {
    expect(computeReadiness(readyInput({ quote: null })).code).toBe("incomplete_amount");
    expect(
      computeReadiness(readyInput({ quote: { route: { kind: "swap", path: [] }, payAmount: "—", receiveAmount: "—" } }))
        .code,
    ).toBe("incomplete_amount");
  });
});
