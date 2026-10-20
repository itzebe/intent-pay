/**
 * Machine-readable payment failure taxonomy.
 *
 * Every failure the app can produce — a readiness gate, a quote error, a wallet
 * error, a signing-guard refusal, an execution error — is mapped here to exactly
 * one stable category. This is the vocabulary the payment-attempt record, the
 * operational error view, and the tests all share.
 *
 * Two rules are load-bearing:
 *   - A *user rejection* is never recorded as a blockchain failure, because no
 *     transaction was submitted.
 *   - A timeout / unknown outcome is `transaction_status_unknown`, never
 *     `transaction_failed`. An unverified outcome must not be described as a
 *     failure, and must not trigger an automatic replacement payment.
 */

export type FailureCategory =
  | "invalid_instructions"
  | "missing_information"
  | "unsupported_asset"
  | "no_route"
  | "wallet_disconnected"
  | "user_rejected"
  | "provider_timeout"
  | "submission_failure"
  | "transaction_reverted"
  | "transaction_pending"
  | "transaction_status_unknown"
  | "confirmed_success"
  | "quote_unavailable"
  | "insufficient_balance"
  | "insufficient_gas"
  | "price_impact_blocked"
  | "unprotected_transaction"
  | "intent_changed"
  | "paymaster_unavailable"
  | "unknown_error";

export type FailureSeverity = "info" | "warning" | "error" | "critical";

export type Classification = {
  category: FailureCategory;
  severity: FailureSeverity;
  /** Whether a transaction may exist and must be reconciled, not retried blindly. */
  mayHaveSubmitted: boolean;
  /** A short, safe, user-facing sentence. */
  message: string;
};

const CLASSIFICATIONS: Record<FailureCategory, Classification> = {
  invalid_instructions: { category: "invalid_instructions", severity: "warning", mayHaveSubmitted: false, message: "The payment instructions are invalid." },
  missing_information: { category: "missing_information", severity: "warning", mayHaveSubmitted: false, message: "The payment is missing required information." },
  unsupported_asset: { category: "unsupported_asset", severity: "warning", mayHaveSubmitted: false, message: "That asset isn't supported on Monad." },
  no_route: { category: "no_route", severity: "warning", mayHaveSubmitted: false, message: "No route can deliver this payment right now." },
  wallet_disconnected: { category: "wallet_disconnected", severity: "warning", mayHaveSubmitted: false, message: "Connect your wallet to continue." },
  user_rejected: { category: "user_rejected", severity: "info", mayHaveSubmitted: false, message: "You declined the request in your wallet." },
  provider_timeout: { category: "provider_timeout", severity: "error", mayHaveSubmitted: false, message: "A provider timed out. Nothing was submitted." },
  submission_failure: { category: "submission_failure", severity: "error", mayHaveSubmitted: true, message: "The transaction could not be submitted." },
  transaction_reverted: { category: "transaction_reverted", severity: "error", mayHaveSubmitted: true, message: "The transaction reverted on-chain." },
  transaction_pending: { category: "transaction_pending", severity: "info", mayHaveSubmitted: true, message: "The transaction is still pending." },
  transaction_status_unknown: { category: "transaction_status_unknown", severity: "warning", mayHaveSubmitted: true, message: "The transaction outcome is unknown. We'll check the chain before any retry." },
  confirmed_success: { category: "confirmed_success", severity: "info", mayHaveSubmitted: true, message: "The payment confirmed on-chain." },
  quote_unavailable: { category: "quote_unavailable", severity: "warning", mayHaveSubmitted: false, message: "A price couldn't be quoted right now." },
  insufficient_balance: { category: "insufficient_balance", severity: "warning", mayHaveSubmitted: false, message: "Your balance doesn't cover this payment." },
  insufficient_gas: { category: "insufficient_gas", severity: "warning", mayHaveSubmitted: false, message: "Your wallet can't cover the network fee." },
  price_impact_blocked: { category: "price_impact_blocked", severity: "warning", mayHaveSubmitted: false, message: "This route's price impact is too high." },
  unprotected_transaction: { category: "unprotected_transaction", severity: "error", mayHaveSubmitted: false, message: "The transaction is missing a required on-chain bound." },
  intent_changed: { category: "intent_changed", severity: "warning", mayHaveSubmitted: false, message: "The payment changed. Review it again." },
  paymaster_unavailable: { category: "paymaster_unavailable", severity: "warning", mayHaveSubmitted: false, message: "Gas can't be paid in a token for this account." },
  unknown_error: { category: "unknown_error", severity: "error", mayHaveSubmitted: false, message: "The payment couldn't be completed." },
};

/** Every category, for tests and the ops view. */
export const FAILURE_CATEGORIES = Object.keys(CLASSIFICATIONS) as FailureCategory[];

export function classificationOf(category: FailureCategory): Classification {
  return CLASSIFICATIONS[category] ?? CLASSIFICATIONS.unknown_error;
}

/**
 * Map an application error code (readiness, quote, signing guard, execution,
 * wallet error) to a taxonomy category. `source` disambiguates codes that mean
 * different things in different layers.
 */
export function classifyCode(
  code: string | undefined | null,
  source: "readiness" | "quote" | "guard" | "execution" | "wallet" | "aa" | "generic" = "generic",
): Classification {
  const c = (code ?? "").toLowerCase();
  if (!c) return CLASSIFICATIONS.unknown_error;

  if (source === "wallet") {
    if (c === "rejected") return CLASSIFICATIONS.user_rejected;
    if (c === "disconnected") return CLASSIFICATIONS.wallet_disconnected;
    if (c === "unsupported") return CLASSIFICATIONS.wallet_disconnected;
    return CLASSIFICATIONS.unknown_error;
  }

  // ExecutionError codes.
  if (source === "execution") {
    if (c === "rejected") return CLASSIFICATIONS.user_rejected;
    if (c === "reverted") return CLASSIFICATIONS.transaction_reverted;
    if (c === "submitted") return CLASSIFICATIONS.transaction_pending;
    if (c === "authorization_failed") return CLASSIFICATIONS.submission_failure;
    if (c === "unknown") return CLASSIFICATIONS.transaction_status_unknown;
  }

  // Signing-guard refusal reasons.
  if (source === "guard") {
    const guardMap: Record<string, FailureCategory> = {
      insufficient_balance: "insufficient_balance",
      insufficient_gas: "insufficient_gas",
      insufficient_gas_token: "insufficient_gas",
      price_impact: "price_impact_blocked",
      unprotected: "unprotected_transaction",
      not_ready: "missing_information",
      intent_changed: "intent_changed",
      intent_mismatch: "intent_changed",
      composer_mismatch: "intent_changed",
      account_changed: "wallet_disconnected",
      quote_stale: "quote_unavailable",
      quote_unavailable: "quote_unavailable",
      unsupported_token: "unsupported_asset",
      route_unavailable: "no_route",
    };
    const mapped = guardMap[c];
    if (mapped) return CLASSIFICATIONS[mapped];
  }

  // Readiness / quote / generic codes.
  const map: Record<string, FailureCategory> = {
    invalid_recipient: "invalid_instructions",
    invalid_amount: "invalid_instructions",
    amount_mismatch: "invalid_instructions",
    incomplete_amount: "missing_information",
    choose_payment_asset: "missing_information",
    no_source: "missing_information",
    unsupported_token: "unsupported_asset",
    ambiguous_token: "unsupported_asset",
    no_route: "no_route",
    route_unavailable: "no_route",
    quote_unavailable: "quote_unavailable",
    provider_error: "provider_timeout",
    price_unavailable: "quote_unavailable",
    insufficient_balance: "insufficient_balance",
    insufficient_gas: "insufficient_gas",
    wallet_incompatible: "paymaster_unavailable",
    insufficient_gas_token: "insufficient_gas",
    gas_token_unsupported: "paymaster_unavailable",
    quote_stale: "quote_unavailable",
    price_impact: "price_impact_blocked",
    unprotected: "unprotected_transaction",
    intent_changed: "intent_changed",
    rejected: "user_rejected",
    reverted: "transaction_reverted",
    submitted: "transaction_pending",
  };
  const mapped = map[c];
  if (mapped) return CLASSIFICATIONS[mapped];
  return CLASSIFICATIONS.unknown_error;
}

/** Map a raw provider/RPC error object to a category. */
export function classifyError(err: unknown, source: Parameters<typeof classifyCode>[1] = "generic"): Classification {
  const e = err as { code?: string | number; name?: string; message?: string } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  if (code) {
    const byCode = classifyCode(code, source);
    if (byCode.category !== "unknown_error") return byCode;
  }
  const msg = (e?.message ?? "").toLowerCase();
  if (/timeout|timed out|etimedout|abort/.test(msg)) return CLASSIFICATIONS.provider_timeout;
  if (/user rejected|user denied|4001/.test(msg)) return CLASSIFICATIONS.user_rejected;
  if (/revert/.test(msg)) return CLASSIFICATIONS.transaction_reverted;
  if (/insufficient funds|insufficient balance/.test(msg)) return CLASSIFICATIONS.insufficient_balance;
  if (/nonce/.test(msg)) return CLASSIFICATIONS.submission_failure;
  return CLASSIFICATIONS.unknown_error;
}
