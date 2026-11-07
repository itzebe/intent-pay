/**
 * The single, closed set of error codes the external developer API returns.
 *
 * A stable, documented code is what lets an integrator branch on a failure
 * without parsing prose. The `message` is always a short, client-safe sentence —
 * never a raw provider string, a stack trace, or a credential (the routes pass
 * upstream failures through `sanitizeUpstreamError`).
 */
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
  "email_unavailable",
  "provider_error",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** HTTP status for each code. Kept explicit so it cannot drift from the code. */
const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  invalid_recipient: 422,
  invalid_amount: 422,
  invalid_chain: 422,
  unsupported_token: 422,
  route_unavailable: 422,
  insufficient_balance: 422,
  invalid_state: 409,
  expired: 410,
  replay_detected: 409,
  already_submitted: 409,
  storage_unavailable: 503,
  email_unavailable: 503,
  provider_error: 502,
  internal_error: 500,
};

export function statusForCode(code: ApiErrorCode): number {
  return STATUS[code] ?? 500;
}

export type ApiErrorBody = {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    /** Optional machine-readable detail (a field name, a state, …). */
    detail?: string;
    /** Optional request id for support correlation. */
    requestId?: string;
  };
};

export function errorBody(code: ApiErrorCode, message: string, detail?: string, requestId?: string): ApiErrorBody {
  return { ok: false, error: { code, message, ...(detail ? { detail } : {}), ...(requestId ? { requestId } : {}) } };
}
