/**
 * The payment-intent lifecycle for the external developer API.
 *
 * This is a *different* lifecycle from the browser's payment-attempt correlation
 * (`PaymentAttemptStatus`): that one tracks a single user's preparation stages
 * and is not a durable, multi-tenant record. The developer API needs a durable,
 * append-only, per-tenant lifecycle, so it gets its own explicit state machine
 * here.
 *
 * Two rules are load-bearing and are enforced by `canTransition`:
 *
 *   1. A *prepared* transaction is not a payment. `PREPARED` only means a
 *      transaction can be built; nothing has been signed or sent.
 *   2. A *submitted* transaction is not a confirmed payment, and a *confirmed*
 *      transaction is not a verified settlement. Each of those is a separate,
 *      explicit transition that only the authoritative chain evidence may cause.
 *
 * The state is derived from the ordered, append-only event rows, so the history
 * cannot be rewritten: the current state is the last event's state, and every
 * transition is validated against the machine below before it is appended.
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

/** States from which no further transition is possible. */
export const TERMINAL_STATES: readonly IntentState[] = ["verified", "rejected", "expired", "failed"];

export function isTerminal(state: IntentState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The allowed transitions. Every edge is deliberate:
 *   - creation → validating → validated | rejected
 *   - validated → prepared
 *   - prepared → awaiting_authorization
 *   - awaiting_authorization → submitted
 *   - submitted → confirmed | failed
 *   - confirmed → verified | failed
 * and any non-terminal state may expire.
 */
const TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  created: ["validating", "rejected", "expired"],
  validating: ["validated", "rejected", "failed", "expired"],
  validated: ["prepared", "failed", "expired"],
  prepared: ["awaiting_authorization", "prepared", "failed", "expired"],
  awaiting_authorization: ["submitted", "failed", "rejected", "expired"],
  submitted: ["confirmed", "failed"],
  confirmed: ["verified", "failed"],
  verified: [],
  rejected: [],
  expired: [],
  failed: [],
};

export function canTransition(from: IntentState, to: IntentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** The set of transitions out of a state, for documentation and errors. */
export function allowedFrom(from: IntentState): readonly IntentState[] {
  return TRANSITIONS[from] ?? [];
}

/** True when a state is at or past authorization (params must be frozen). */
export function isAuthorizedOrBeyond(state: IntentState): boolean {
  return (
    state === "awaiting_authorization" ||
    state === "submitted" ||
    state === "confirmed" ||
    state === "verified" ||
    state === "failed"
  );
}

/**
 * The webhook event name emitted when an intent enters each state. `validating`
 * and `awaiting_authorization` are internal checkpoints with no dedicated event
 * in the public contract, so they emit nothing (see `eventsForState`).
 *
 * These are the *intent-level* (transaction-level) events. An intent driven
 * through a merchant checkout emits the checkout-scoped `checkout.*` / `payment.*`
 * events instead (see `CHECKOUT_EVENTS`), so a merchant receives exactly one
 * event per lifecycle fact rather than two views of the same one.
 */
export const STATE_EVENT: Partial<Record<IntentState, string>> = {
  created: "intent.created",
  validated: "intent.validated",
  prepared: "transaction.prepared",
  submitted: "transaction.submitted",
  confirmed: "transaction.confirmed",
  verified: "payment.verified",
  rejected: "payment.rejected",
  failed: "payment.failed",
  expired: "intent.expired",
};

/**
 * The checkout-scoped (merchant/order-level) events.
 *
 * A merchant thinks in orders, not transactions, so a checkout emits
 * `payment.submitted` when the customer's transaction is recorded,
 * `payment.confirmed` when the chain confirms the receipt, and
 * `payment.verified` only after independent settlement verification proves the
 * recipient was paid. `payment.failed` covers a reverted/short settlement.
 */
export const CHECKOUT_EVENTS = [
  "checkout.created",
  "checkout.expired",
  "payment.submitted",
  "payment.confirmed",
  "payment.verified",
  "payment.failed",
] as const;

/** Every webhook event the API can emit. */
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

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}
