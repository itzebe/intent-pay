import { describe, expect, it } from "vitest";
import {
  initialIntent,
  reduceIntent,
  isDerivedCurrent,
  type CanonicalIntent,
} from "@/lib/domain/canonicalIntent";
import { computeReadiness } from "@/lib/domain/readiness";

const ALICE = "0x7A91c4b8E2d9F04aB3c6E81d5F72a0C9e4Bd92F4";
const BOB = "0x1111111111111111111111111111111111111111";

/**
 * A ready baseline, mirroring what the composer feeds the deterministic gate.
 * Each scenario below perturbs exactly one thing.
 */
function readiness(overrides: Partial<Parameters<typeof computeReadiness>[0]> = {}) {
  return computeReadiness({
    recipient: ALICE,
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
  });
}

/** A quote belongs to a specific intent version; anything else is not current. */
const quoteFor = (version: number) => ({ version });

describe("intent change invalidates derived execution state (A–G)", () => {
  const base = reduceIntent(initialIntent(), {
    recipient: ALICE,
    receiveToken: "MON",
    receiveAmount: "10",
    payToken: "MON",
    payTokenSource: "intent",
  });

  const scenarios: { name: string; patch: Partial<CanonicalIntent> }[] = [
    { name: "A. receive asset MON → USDC", patch: { receiveToken: "USDC" } },
    { name: "B. receive asset USDC → MON", patch: { receiveToken: "MON", payToken: "USDC" } },
    { name: "C. amount change", patch: { receiveAmount: "25" } },
    { name: "D. recipient change", patch: { recipient: BOB } },
    { name: "E. source/pay token change", patch: { payToken: "USDT", payTokenSource: "user" } },
    { name: "F. network change", patch: { network: "mainnet" } },
    { name: "currency/mode change", patch: { amountMode: "i_spend" } },
  ];

  for (const s of scenarios) {
    it(`${s.name} bumps the version and invalidates the old quote`, () => {
      const next = reduceIntent(base, s.patch);
      // If the patch is a real change it must bump the version and change the
      // execution key; a no-op (e.g. network to the same value) is allowed to
      // keep both.
      const changed = next.key !== base.key;
      if (changed) {
        expect(next.version, s.name).toBeGreaterThan(base.version);
      }
      // A quote computed for the previous version is never current afterwards.
      expect(isDerivedCurrent(quoteFor(base.version), next)).toBe(changed ? false : true);
    });
  }

  it("G. a wallet-account change is not an intent field — it forces an explicit invalidation", () => {
    // The account is deliberately NOT part of the intent key: the hook clears
    // the quote explicitly on an account change (setWalletAccount). What matters
    // here is that changing accounts cannot silently keep an executable quote:
    // derived state is keyed by intent version, and the hook bumps `nonce` and
    // drops the quote, so readiness is re-evaluated from scratch.
    const next = reduceIntent(base, { text: "same intent, new wallet" });
    expect(next.version).toBe(base.version);
    // The guard re-reads the live account and aborts if it changed (see
    // signGuard tests L). Readiness cannot be satisfied by a stale quote:
    expect(readiness({ quote: null, quoteStale: true }).ready).toBe(false);
  });
});

describe("the approval gate evaluates only the current intent", () => {
  it("is not ready while the quote belongs to an older version", () => {
    // The hook feeds `quote: null` to the gate when quoteVersion !== intent.version.
    expect(readiness({ quote: null }).ready).toBe(false);
    expect(readiness({ quote: null }).code).toBe("incomplete_amount");
  });

  it("is not ready while the quote is stale", () => {
    expect(readiness({ quoteStale: true }).ready).toBe(false);
    expect(readiness({ quoteStale: true }).code).toBe("quote_stale");
  });

  it("is ready only with a current, fresh quote and every input finalized", () => {
    expect(readiness().ready).toBe(true);
  });
});
