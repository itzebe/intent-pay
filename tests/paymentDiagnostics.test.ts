import { describe, expect, it, vi, afterEach } from "vitest";
import {
  PAYMENT_STAGES,
  buildPaymentDiagnostic,
  recordPaymentDiagnostic,
} from "@/lib/domain/paymentDiagnostics";

/**
 * The Confirm-and-Send loop was unattributable because no stage information
 * survived a failure. These tests pin the diagnostic record's shape, its fixed
 * stage list, and — critically — that it never carries a secret or a raw
 * provider payload.
 */
describe("paymentDiagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a fixed, ordered stage list covering the whole path", () => {
    expect(PAYMENT_STAGES[0]).toBe("payment_submit_started");
    expect(PAYMENT_STAGES).toContain("authorization_signing_started");
    expect(PAYMENT_STAGES).toContain("authorization_signing_completed");
    expect(PAYMENT_STAGES).toContain("user_operation_preparation_completed");
    expect(PAYMENT_STAGES).toContain("bundler_submission_completed");
    expect(PAYMENT_STAGES).toContain("user_operation_included");
    expect(PAYMENT_STAGES[PAYMENT_STAGES.length - 1]).toBe("payment_execution_verified");
    // "payment_failed" is terminal and recorded on error, not part of the happy list.
    expect(PAYMENT_STAGES).not.toContain("payment_failed");
  });

  it("builds a record with sensible defaults that cannot be secrets", () => {
    const diag = buildPaymentDiagnostic({ event: "payment_failed", code: "account_changed" });
    expect(diag.event).toBe("payment_failed");
    expect(diag.code).toBe("account_changed");
    expect(typeof diag.at).toBe("number");
  });

  it("emits a sanitised, secret-free JSON record", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordPaymentDiagnostic(
      buildPaymentDiagnostic({
        event: "payment_failed",
        code: "rejected",
        // A pathological message: control chars + an over-long body.
        message: "line1\nline2\u0000" + "x".repeat(500),
        walletRejected: true,
        mayHaveSubmitted: false,
        returnedToConfirm: true,
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0][0] as string);
    expect(payload.event).toBe("payment_failed");
    expect(payload.walletRejected).toBe(true);
    expect(payload.returnedToConfirm).toBe(true);
    // No newline/control characters survive, and the message is capped.
    expect(payload.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(payload.message.length).toBeLessThanOrEqual(300);
    // No sensitive field names are ever emitted.
    const keys = Object.keys(payload);
    for (const forbidden of ["privateKey", "seed", "signature", "token", "secret"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
