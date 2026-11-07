/**
 * Typed errors.
 *
 * Every failure the API can produce is a stable, documented `code`. The SDK maps
 * each one to a concrete `IntentPayError` subclass so an integrator can branch
 * with `instanceof` or on `code` — never by parsing a message. The raw upstream
 * text is never surfaced: the server already returns a short, client-safe
 * sentence, and the SDK passes it through unchanged.
 */

/** The closed set of error codes the API returns (mirrors `lib/developer/errors.ts`). */
export const API_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "rate_limited",
  "invalid_recipient",
  "invalid_amount",
  "invalid_chain",
  "unsupported_token",
  "route_unavailable",
  "insufficient_balance",
  "invalid_state",
  "expired",
  "replay_detected",
  "already_submitted",
  "storage_unavailable",
  "provider_error",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Codes the SDK itself can raise, before or after a request. Prefixed with
 * `client_`/`transport_` so they can never be confused with a server code.
 */
export const SDK_ERROR_CODES = [
  "client_invalid_config",
  "client_missing_credential",
  "client_credential_in_browser",
  "transport_network_error",
  "transport_timeout",
  "transport_bad_response",
  "wallet_not_found",
  "wallet_rejected",
  "wallet_wrong_chain",
  "wallet_no_account",
  "wallet_unknown_outcome",
] as const;

export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number];

export type ErrorCode = ApiErrorCode | SdkErrorCode;

/** Context attached to every error, for logging and support correlation. */
export type ErrorContext = {
  /** HTTP status, when the failure came from a response. */
  status?: number;
  /** The server's request id, for support correlation. */
  requestId?: string;
  /** The specific field the server flagged, when it did. */
  detail?: string;
  /** The endpoint path (no query string, no credential). */
  path?: string;
  /** The raw response body text, when a body could not be parsed. */
  body?: string;
};

/** The base class for every error this SDK throws. */
export class IntentPayError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly detail?: string;
  readonly path?: string;
  readonly body?: string;

  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = "IntentPayError";
    this.code = code;
    if (context.status !== undefined) this.status = context.status;
    if (context.requestId !== undefined) this.requestId = context.requestId;
    if (context.detail !== undefined) this.detail = context.detail;
    if (context.path !== undefined) this.path = context.path;
    if (context.body !== undefined) this.body = context.body;
  }
}

/**
 * The error thrown for any non-2xx API response.
 *
 * `retryable` is derived from the code and status: a network blip, a rate limit
 * or a provider hiccup can be retried; a validation failure or a conflict cannot.
 */
export class ApiError extends IntentPayError {
  readonly apiCode: ApiErrorCode;
  readonly retryable: boolean;

  constructor(apiCode: ApiErrorCode, message: string, context: ErrorContext = {}) {
    super(apiCode, message, context);
    this.name = "ApiError";
    this.apiCode = apiCode;
    this.retryable = RETRYABLE_API_CODES.has(apiCode);
  }
}

/** Raised when the request never produced an HTTP response (DNS, offline, reset). */
export class TransportError extends IntentPayError {
  readonly retryable: boolean;

  constructor(code: "transport_network_error" | "transport_timeout" | "transport_bad_response", message: string, context: ErrorContext = {}) {
    super(code, message, context);
    this.name = "TransportError";
    this.retryable = code !== "transport_bad_response";
  }
}

/** Raised for a configuration problem detected before any request is sent. */
export class ConfigurationError extends IntentPayError {
  constructor(code: "client_invalid_config" | "client_missing_credential" | "client_credential_in_browser", message: string) {
    super(code, message);
    this.name = "ConfigurationError";
  }
}

/** Raised for wallet-layer failures (no wallet, wrong chain, user rejection). */
export class WalletError extends IntentPayError {
  readonly walletCode: SdkErrorCode;

  constructor(
    code:
      | "wallet_not_found"
      | "wallet_rejected"
      | "wallet_wrong_chain"
      | "wallet_no_account"
      | "wallet_unknown_outcome",
    message: string,
  ) {
    super(code, message);
    this.name = "WalletError";
    this.walletCode = code;
  }
}

/** The API codes a caller may safely retry (with backoff). */
const RETRYABLE_API_CODES = new Set<ApiErrorCode>([
  "rate_limited",
  "provider_error",
  "storage_unavailable",
  "internal_error",
]);

/** True when a thrown value is an `IntentPayError` of any kind. */
export function isIntentPayError(err: unknown): err is IntentPayError {
  return err instanceof IntentPayError;
}

/**
 * Whether a thrown value is safe to retry automatically.
 *
 * A `TransportError` and the small set of transient `ApiError` codes are
 * retryable. **A wallet rejection, a validation failure and an ambiguous
 * submission failure are never retried** — see `isAmbiguousSubmission`.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.retryable;
  if (err instanceof TransportError) return err.retryable;
  return false;
}

/**
 * Whether a failure may have left a transaction on-chain.
 *
 * A `submitted`-class failure (a timeout or a transport error while broadcasting,
 * or a `provider_error` from `submit`) means the transaction may already exist.
 * The SDK exposes this so a caller **never blindly resubmits**: the safe path is
 * to re-read the intent and verify, not to send again.
 */
export function isAmbiguousSubmission(err: unknown): boolean {
  if (err instanceof TransportError) return err.code === "transport_timeout" || err.code === "transport_network_error";
  if (err instanceof ApiError) return err.apiCode === "provider_error" || err.apiCode === "internal_error";
  return false;
}
