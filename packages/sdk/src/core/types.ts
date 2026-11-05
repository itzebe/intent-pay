/**
 * Shared, transport-level types for the Intent Pay SDK.
 *
 * These mirror the *server's* contract exactly (see `lib/developer/*` in the
 * Intent Pay application). They are intentionally narrow: the SDK never widens
 * a type beyond what the API returns, so a field the server does not send can
 * never be assumed present by an integrator.
 */

/** The only network Intent Pay supports. */
export const MONAD_CHAIN_ID = 143 as const;

/** The API version this SDK targets. The version is in the URL path. */
export const API_VERSION = "v1" as const;

/**
 * The payment-intent lifecycle, as implemented by the server state machine.
 *
 * Two facts are load-bearing and the SDK's helpers encode them:
 *  - `prepared` is **not** a payment. It only means a transaction can be built.
 *  - `submitted` is **not** a payment, and `confirmed` is **not** a settled one.
 *    Only `verified` means the recipient was proven paid on-chain.
 */
export const INTENT_STATES = [
  "created",
  "validating",
  "validated",
  "prepared",
  "awaiting_authorization",
  "submitted",
  "confirmed",
  "verified",
  "rejected",
  "expired",
  "failed",
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

/** States from which the intent can no longer move. */
export const TERMINAL_INTENT_STATES: readonly IntentState[] = ["verified", "rejected", "expired", "failed"];

/** True when an intent can no longer change state. */
export function isTerminalIntentState(state: IntentState): boolean {
  return TERMINAL_INTENT_STATES.includes(state);
}

/**
 * True only when the payment is *proven settled* on-chain.
 *
 * Deliberately distinct from "a transaction was submitted" and from "a receipt
 * succeeded" — the SDK will never report a successful payment for either.
 */
export function isSettled(state: IntentState): boolean {
  return state === "verified";
}

/** Every webhook event the API emits. */
export const WEBHOOK_EVENTS = [
  "intent.created",
  "intent.validated",
  "transaction.prepared",
  "transaction.submitted",
  "transaction.confirmed",
  "payment.verified",
  "payment.failed",
  "payment.rejected",
  "intent.expired",
  "checkout.created",
  "checkout.expired",
  "payment.submitted",
  "payment.confirmed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * The merchant-facing checkout status, derived from the bound intent's real
 * lifecycle. `completed` is only ever reached after settlement is verified.
 */
export const CHECKOUT_STATES = ["open", "completed", "expired", "canceled", "failed"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATES)[number];

/**
 * The customer-facing payment phase. Deliberately finer-grained than the status
 * so a checkout UI never says "paid" before the chain proves delivery.
 */
export const CHECKOUT_PHASES = [
  "awaiting_payment",
  "awaiting_wallet",
  "transaction_submitted",
  "transaction_confirmed",
  "payment_verified",
  "payment_failed",
  "expired",
  "canceled",
] as const;
export type CheckoutPhase = (typeof CHECKOUT_PHASES)[number];

/** True only when the checkout's payment is proven settled on-chain. */
export function isCheckoutPaid(phase: CheckoutPhase): boolean {
  return phase === "payment_verified";
}

/** How the recipient's amount is interpreted. */
export type AmountMode = "recipient_receives" | "i_spend";

/** A public intent, exactly as the API serializes it. */
export type Intent = {
  id: string;
  object: "intent";
  state: IntentState;
  chainId: number;
  recipient: string;
  receiveToken: string;
  receiveTokenAddress: string;
  amountMode: AmountMode;
  amount: string;
  payToken: string | null;
  reference: string | null;
  authorized: boolean;
  createdAt: string;
  updatedAt: string;
};

/** One entry in an intent's append-only lifecycle history. */
export type LifecycleEntry = {
  state: IntentState;
  at: string;
  detail: string | null;
};

/** How a checkout is attributed to its destination. */
export type AttributionMode = "checkout_bound" | "shared_recipient";

/**
 * How a checkout is attributed. `checkout_bound` means the order is paid to a
 * destination unique to it (derived from the merchant's watch-only payment xpub);
 * `shared_recipient` means it falls back to the merchant's shared recipient and
 * relies on the token/amount/time guards. Never presented as equivalent.
 */
export type CheckoutAttribution = {
  mode: AttributionMode;
  /** The unique destination, or null in shared-recipient mode. */
  destination: string | null;
  /** The derivation index this destination came from, or null. */
  derivationIndex: number | null;
};

/**
 * A merchant checkout session — the payable *order* a merchant shares with a
 * customer. It binds a public payment token to an intent; the amount, asset and
 * recipient live on the intent and are frozen at creation.
 */
export type Checkout = {
  id: string;
  object: "checkout";
  status: CheckoutStatus;
  phase: CheckoutPhase;
  intentId: string;
  orderReference: string | null;
  /** The public payment-link handle (safe to share with the customer). */
  token: string;
  tokenHint: string;
  /** Whether this order has a unique destination, or shares the recipient. */
  attribution: CheckoutAttribution;
  expiresAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The customer-facing view of a checkout, fetched by its public token. */
export type PublicCheckout = {
  id: string;
  object: "checkout";
  status: CheckoutStatus;
  phase: CheckoutPhase;
  orderReference: string | null;
  chainId: number;
  recipient: string;
  attribution: CheckoutAttribution;
  receiveToken: string;
  receiveTokenAddress: string;
  amountMode: AmountMode;
  amount: string;
  payToken: string | null;
  expiresAt: string;
  createdAt: string;
};

/** The settlement verdict for a checkout's on-chain payment. */
export type CheckoutSettlement = {
  verdict: SettlementVerdict;
  delivered: string | null;
  expected: string;
  blockNumber: number | null;
  chainId: number | null;
  message: string;
  /** The transaction that delivered (a swap is several txs). */
  txHash?: string;
};

/** A registered webhook destination (never carries its signing secret). */
export type Webhook = {
  id: string;
  object: "webhook";
  url: string;
  description: string | null;
  events: string[];
  status: string;
  createdAt: string;
};

/** One webhook delivery attempt. */
export type WebhookDelivery = {
  id: string;
  object: "webhook_delivery";
  webhookId: string;
  event: string;
  eventId: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
};

/** An API key's public metadata (never its secret). */
export type ApiKeyInfo = {
  id: string;
  name: string;
  prefix: string;
  environment: "live" | "test";
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** A single encoded call the caller's wallet must send. */
export type PreparedCall = {
  /** Contract (or recipient) the call targets. */
  to: string;
  /** ABI-encoded calldata, or `"0x"` for a plain value transfer. */
  data: string;
  /** Native MON value in wei, as a decimal string. */
  value: string;
};

/** The quote that accompanies a prepared plan. */
export type PreparedQuote = {
  payToken: string;
  payAmount: string;
  receiveToken: string;
  receiveAmount: string;
  minimumReceived: string;
  slippageBps: number;
  networkCostUsd: number;
};

/** The result of preparing a transaction for a wallet. */
export type PreparedTransaction = {
  state: IntentState;
  sender: string;
  /** Send these in order. The wallet signs and broadcasts them itself. */
  calls: PreparedCall[];
  steps: string[];
  quote: PreparedQuote;
  /** The frozen-parameter fingerprint the wallet approval should display. */
  fingerprint: string;
  /** Explicit reminder that this is not yet a payment. */
  note: string;
};

/** The result of validating an intent. */
export type ValidationResult = {
  valid: boolean;
  validation: {
    ok: boolean;
    chainId: number;
    recipient: { valid: boolean; address?: string; reason?: string };
    receiveToken: { symbol: string; address: string; exists: boolean; reason?: string };
    amount: { valid: boolean; value?: string; reason?: string };
    payToken: string | null;
    route?: { available: boolean; path?: string[]; reason?: string } | null;
    receiveAmountToken?: string;
  };
  state: IntentState;
};

/** The independent settlement verdicts the server can return. */
export type SettlementVerdict =
  | "verified"
  | "reverted"
  | "pending"
  | "not_found"
  | "short"
  | "unavailable"
  | "invalid_hash"
  /** The transaction predates the order — it cannot be this order's payment. */
  | "historical"
  /** The receipt is mined but not yet past the finality policy. */
  | "unconfirmed";

/** The evidence behind a settlement verdict. */
export type SettlementCheck = {
  verdict: SettlementVerdict;
  /** Decimal string actually delivered to the recipient (when measurable). */
  delivered: string | null;
  /** Decimal string the intent requested. */
  expected: string;
  blockNumber: number | null;
  chainId: number | null;
  message: string;
  /**
   * The transaction this verdict is about. A swap is several transactions and the
   * one that pays the recipient is not necessarily the first, so this names the
   * hash that actually delivered.
   */
  txHash?: string;
};

/** The result of a settlement verification call. */
export type SettlementResult = {
  verdict: SettlementVerdict;
  state: IntentState;
  settlement: SettlementCheck;
  /** Present and true when the outcome is not final and a retry is meaningful. */
  retryable?: boolean;
};

/** A registered asset, from `getCapabilities()`. */
export type AssetCapability = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  native: boolean;
};

/** The machine-readable capabilities document. */
export type Capabilities = {
  ok: true;
  apiVersion: string;
  network: { key: string; name: string; chainId: number; explorer: string };
  networks: { key: string; chainId: number }[];
  assets: AssetCapability[];
  /** Endpoints authenticated with an API key. */
  endpoints: { method: string; path: string; description: string }[];
  /** Public, unauthenticated endpoints (the customer's token-authenticated checkout). */
  publicEndpoints?: { method: string; path: string; description: string }[];
  intentStates: IntentState[];
  /** The states a checkout can be in, when merchant checkouts are enabled. */
  checkoutStates?: CheckoutStatus[];
  webhookEvents: string[];
  features: {
    frozenParameters: boolean;
    idempotencyKeys: boolean;
    independentVerification: boolean;
    webhookSigning: string;
    webhookMaxAttempts: number;
    credentialCanSign: boolean;
    keyCustody: boolean;
    /** Merchant checkout sessions (payment links + QR) over the same intents. */
    merchantCheckouts?: boolean;
    /** The customer's own wallet authorizes every transaction; never the merchant. */
    customerAuthorizesPayment?: boolean;
    /** Whether per-order (checkout-bound) attribution is available. */
    checkoutAttribution?: {
      checkoutBoundAvailable: boolean;
      custodial: boolean;
      defaultMode: "checkout_bound" | "shared_recipient";
    };
  };
  storage: {
    kind: string;
    durability: string;
    durable: boolean;
    reason: string | null;
  };
  auth: {
    scheme: string;
    header: string;
    testKeysAccepted: boolean;
    signup: string;
  };
};
