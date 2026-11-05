/**
 * `@intentpay/sdk` — the Intent Pay server client.
 *
 * This entry point is **server-safe**: it has no DOM dependency and contains no
 * wallet code, so it can be imported in a Next.js route handler, an Express
 * server, a worker or a cron job without pulling in browser APIs. The browser
 * wallet layer lives at `@intentpay/sdk/wallet`, and webhook verification at
 * `@intentpay/sdk/webhooks`.
 */

export { IntentPay } from "./core/client.js";
export type {
  AccountInfo,
  AttributionConfig,
  AuthorizeResult,
  CheckoutEvidence,
  CheckoutVerifyResult,
  CreateCheckoutInput,
  CreateCheckoutResult,
  CreateIntentInput,
  CreateIntentResult,
  CreateWebhookInput,
  CreateWebhookResult,
  GetCheckoutResult,
  GetIntentResult,
  PaymentStatus,
  PrepareInput,
  SubmitInput,
  SubmitResult,
  VerifyInput,
} from "./core/client.js";

export {
  IntentPayError,
  ApiError,
  TransportError,
  ConfigurationError,
  WalletError,
  isIntentPayError,
  isRetryable,
  isAmbiguousSubmission,
  API_ERROR_CODES,
  SDK_ERROR_CODES,
} from "./core/errors.js";
export type { ApiErrorCode, SdkErrorCode, ErrorCode, ErrorContext } from "./core/errors.js";

export {
  resolveConfig,
  normalizeBaseUrl,
  assertApiKeyShape,
  isBrowserEnvironment,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from "./core/config.js";
export type { IntentPayConfig, ResolvedConfig } from "./core/config.js";

export { backoffDelay, parseRetryAfter, shouldRetry } from "./core/transport.js";
export type { RequestOptions, RawResponse } from "./core/transport.js";

export {
  MONAD_CHAIN_ID,
  API_VERSION,
  INTENT_STATES,
  TERMINAL_INTENT_STATES,
  WEBHOOK_EVENTS,
  CHECKOUT_STATES,
  CHECKOUT_PHASES,
  isTerminalIntentState,
  isSettled,
  isCheckoutPaid,
} from "./core/types.js";
export type {
  AmountMode,
  ApiKeyInfo,
  AssetCapability,
  AttributionMode,
  Capabilities,
  Checkout,
  CheckoutAttribution,
  CheckoutPhase,
  CheckoutSettlement,
  CheckoutStatus,
  Intent,
  IntentState,
  LifecycleEntry,
  PreparedCall,
  PreparedQuote,
  PreparedTransaction,
  PublicCheckout,
  SettlementCheck,
  SettlementResult,
  SettlementVerdict,
  ValidationResult,
  Webhook,
  WebhookDelivery,
  WebhookEvent,
} from "./core/types.js";
