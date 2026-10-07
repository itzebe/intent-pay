import { isEvmAddress } from "@/lib/format";

/**
 * Deterministic payment-readiness gate.
 *
 * This is the single authority for whether a payment may enter Review or be
 * signed. It is pure and total, so it can be unit-tested and so the UI's
 * visual state can never be the only thing standing between a user and an
 * incomplete payment: `isReady()` is re-evaluated (and `onConfirm` re-checks
 * freshness) before anything is submitted.
 *
 * A payment is READY only when every execution input is finalized and
 * validated. Every unresolved or failed requirement yields a specific,
 * actionable code + call-to-action instead of a generic message.
 */

export type ReadinessCode =
  | "invalid_recipient"
  | "choose_payment_asset"
  | "amount_mismatch"
  | "quoting"
  | "quote_stale"
  | "no_route"
  | "unsupported_token"
  | "quote_unavailable"
  | "incomplete_amount"
  | "insufficient_balance"
  | "insufficient_gas"
  | "ready";

export type Readiness = {
  ready: boolean;
  code: ReadinessCode;
  /** Label for the Review CTA — short and explicit. */
  cta: string;
  /** Optional secondary line explaining the state. */
  message?: string;
  severity: "info" | "warn" | "error";
  /** When true the user can retry by refreshing the quote. */
  retryable?: boolean;
};

export type ReadinessInput = {
  recipient: string;
  /** The user has explicitly supplied (or confirmed) the recipient address. */
  recipientConfirmed: boolean;
  /** The source/payment asset has been explicitly established. */
  payTokenIsSet: boolean;
  payToken: string;
  receiveToken: string;
  quoting: boolean;
  quote: {
    route?: { kind?: string; path?: string[] } | null;
    payAmount?: string;
    receiveAmount?: string;
  } | null;
  quoteError: { code: string; message?: string } | null;
  quoteStale: boolean;
  sufficiency: { status: "ok" | "insufficient" | "unknown"; required?: string; available?: string };
  gasSufficiency: { status: "ok" | "insufficient" | "unknown"; requiredMon?: string };
  mismatchActive: boolean;
};

const AMOUNT_MISSING = (v: string | undefined) => !v || v === "—" || v.trim() === "";

export function computeReadiness(input: ReadinessInput): Readiness {
  const {
    recipient,
    recipientConfirmed,
    payTokenIsSet,
    payToken,
    receiveToken,
    quoting,
    quote,
    quoteError,
    quoteStale,
    sufficiency,
    gasSufficiency,
    mismatchActive,
  } = input;

  // 1. Recipient must be a valid address that the user has actually supplied.
  if (!isEvmAddress((recipient ?? "").trim())) {
    return {
      ready: false,
      code: "invalid_recipient",
      cta: "Enter a valid Monad address",
      severity: "warn",
    };
  }
  if (!recipientConfirmed) {
    return {
      ready: false,
      code: "invalid_recipient",
      cta: "Confirm recipient address",
      message: "Enter or confirm the recipient's Monad address.",
      severity: "warn",
    };
  }

  // 2. The source/payment asset must be explicitly established. We never
  //    silently pick one — an unspecified source blocks progression.
  if (!payTokenIsSet) {
    return {
      ready: false,
      code: "choose_payment_asset",
      cta: "Choose payment asset",
      message: "Select which asset you want to pay with.",
      severity: "info",
    };
  }

  // 3. An over-delivery mismatch must be corrected before signing.
  if (mismatchActive) {
    return { ready: false, code: "amount_mismatch", cta: "Fix amount to continue", severity: "warn" };
  }

  // 4. A quote in flight is not ready.
  if (quoting) {
    return { ready: false, code: "quoting", cta: "Pricing…", severity: "info" };
  }

  // 5. A stale quote must be refreshed before it can be reviewed or signed.
  if (quoteStale) {
    return {
      ready: false,
      code: "quote_stale",
      cta: "Refreshing quote…",
      message: "The price expired. Getting a fresh one.",
      severity: "info",
      retryable: true,
    };
  }

  // 6. A quote error blocks progression, mapped to a specific, actionable code.
  if (quoteError) {
    switch (quoteError.code) {
      case "route_unavailable":
        return {
          ready: false,
          code: "no_route",
          cta: `No route available for ${payToken} → ${receiveToken}`,
          message: "Choose another payment asset.",
          severity: "error",
        };
      case "unsupported_token":
        return {
          ready: false,
          code: "unsupported_token",
          cta: `Can't use ${payToken}`,
          message: quoteError.message ?? "That token isn't supported.",
          severity: "error",
        };
      case "invalid_recipient":
        return { ready: false, code: "invalid_recipient", cta: "Enter a valid Monad address", severity: "warn" };
      case "invalid_amount":
        return { ready: false, code: "incomplete_amount", cta: "Enter an amount", severity: "warn" };
      default:
        return {
          ready: false,
          code: "quote_unavailable",
          cta: "Couldn't get a live quote",
          message: "Try again.",
          severity: "error",
          retryable: true,
        };
    }
  }

  // 7. A finalized quote is required, with no unresolved "—" amounts.
  if (!quote || AMOUNT_MISSING(quote.payAmount) || AMOUNT_MISSING(quote.receiveAmount)) {
    return {
      ready: false,
      code: "incomplete_amount",
      cta: "Enter an amount",
      severity: "info",
    };
  }

  // 8. The sender must hold enough of the payment asset.
  if (sufficiency.status === "insufficient") {
    return {
      ready: false,
      code: "insufficient_balance",
      cta: `Insufficient ${payToken} balance`,
      message: `You need ${sufficiency.required ?? "more"} ${payToken}, but hold ${sufficiency.available ?? "0"}.`,
      severity: "error",
    };
  }

  // 9. The wallet must be able to cover the network fee (MON), unless sponsored.
  if (gasSufficiency.status === "insufficient") {
    return {
      ready: false,
      code: "insufficient_gas",
      cta: "Not enough MON for network fee",
      message: `This payment needs about ${gasSufficiency.requiredMon ?? "some"} MON for gas.`,
      severity: "error",
    };
  }

  return { ready: true, code: "ready", cta: "Review payment", severity: "info" };
}

/** Convenience boolean for callers that only need the gate. */
export function isPaymentReady(input: ReadinessInput): boolean {
  return computeReadiness(input).ready;
}
