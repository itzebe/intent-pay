"use client";

/**
 * Structured, secret-free checkout diagnostics.
 *
 * A customer-facing payment can fail at several distinct stages (wallet
 * connection, quote/prepare, signing, broadcast, receipt, verification). The
 * report for each failure must be specific, but it must never carry a credential,
 * a pairing secret, a signed payload or a raw provider string — those leak
 * internal detail and can be sensitive. This helper emits a single structured
 * line with only non-sensitive, enumerated fields.
 *
 * It is deliberately tiny and pure: the caller supplies the stage and a small
 * set of labels, and nothing here can echo a wallet request body.
 */

export type CheckoutStage =
  | "load"
  | "connect"
  | "prepare"
  | "sign"
  | "broadcast"
  | "receipt"
  | "submit"
  | "verify";

export type CheckoutDiagnostic = {
  stage: CheckoutStage;
  /** The wallet connection kind, when known. Never an address or a key. */
  walletKind?: "injected" | "walletconnect" | "none";
  /** The chain the wallet is on, when known. */
  chainId?: number;
  /** The step being executed, when the failure happened mid-plan. */
  step?: string;
  /** A short, enumerated failure category (e.g. `rejected`, `route_unavailable`). */
  code?: string;
};

/** Emit one structured diagnostic line. Never throws, never blocks. */
export function logCheckoutDiagnostic(d: CheckoutDiagnostic): void {
  try {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: "warn", scope: "checkout", ...d }));
  } catch {
    // Logging must never break a payment.
  }
}

/** Map an arbitrary thrown value to a short, non-sensitive failure category. */
export function diagnosticCodeOf(err: unknown): string | undefined {
  if (err == null) return undefined;
  if (typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return `eip1193_${code}`;
    if (typeof code === "string" && code) return code.slice(0, 40);
  }
  const name = (err as { name?: unknown })?.name;
  if (typeof name === "string" && name) return name.slice(0, 40);
  return undefined;
}
