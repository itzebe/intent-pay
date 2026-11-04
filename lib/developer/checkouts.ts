import { getStore } from "@/lib/store";
import type { ApiCheckoutRecord, ApiIntentRecord } from "@/lib/store/types";
import { newCheckoutId, newCheckoutToken } from "./ids";
import { isValidCheckoutToken } from "./checkoutToken";
import { currentState, expireIfStale, intentEvents, submittedTxHashes } from "./intents";
import type { IntentState } from "./intentLifecycle";

/**
 * Merchant checkout sessions.
 *
 * A checkout is the merchant-facing *order*: it binds a payable order to a
 * developer-API intent, which holds the amount, asset and recipient. The
 * checkout deliberately stores none of the payment parameters itself, so a
 * customer can never be shown a different recipient/amount/asset than the one
 * the merchant authorized — the parameters live on the intent, are frozen at
 * authorization, and are re-validated byte-for-byte on every write.
 *
 * Two lifecycles are kept in step but not conflated:
 *
 *   - the *intent* lifecycle (`created → … → verified`), which is the on-chain
 *     truth and the only thing that can prove a payment, and
 *   - the *checkout* status (`open → completed | expired | canceled | failed`),
 *     which is the order view a merchant reads.
 *
 * `checkoutStatus` derives the order view from the intent's real state, so a
 * checkout can never report `completed` unless the intent is `verified`.
 */

/** How long a checkout link stays payable. 30 minutes matches the intent TTL. */
export const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export type CheckoutStatus = "open" | "completed" | "expired" | "canceled" | "failed";

/**
 * The customer-facing phase, distinct from the merchant-facing status.
 *
 * `awaiting_wallet` and `submitted` are deliberately separate: a broadcast
 * transaction is not a confirmed one, and a confirmed one is not a verified
 * settlement. The checkout UI reads this so it never says "paid" too early.
 */
export type CheckoutPhase =
  | "awaiting_payment"
  | "awaiting_wallet"
  | "transaction_submitted"
  | "transaction_confirmed"
  | "payment_verified"
  | "payment_failed"
  | "expired"
  | "canceled";

/** A short display handle (never sufficient to redeem a link). */
function hintOf(token: string): string {
  return token.slice(-8);
}

/** The merchant-facing status derived from the bound intent's real state. */
export function checkoutStatus(record: ApiCheckoutRecord, intentState: IntentState, now = Date.now()): CheckoutStatus {
  if (record.status === "canceled") return "canceled";
  if (intentState === "verified") return "completed";
  if (intentState === "failed" || intentState === "rejected") return "failed";
  if (intentState === "expired") return "expired";
  if (record.status === "expired") return "expired";
  if (now > record.expiresAt && intentState !== "submitted" && intentState !== "confirmed") {
    return "expired";
  }
  return "open";
}

/** The customer-facing phase derived from the intent's real state. */
export function checkoutPhase(record: ApiCheckoutRecord, intentState: IntentState, now = Date.now()): CheckoutPhase {
  // A canceled order is canceled regardless of what its bound intent later
  // becomes. Cancellation expires the intent, so checking the intent state first
  // would report a canceled order as merely "expired" and lose the reason.
  if (record.status === "canceled") return "canceled";
  switch (intentState) {
    case "verified":
      return "payment_verified";
    case "confirmed":
      return "transaction_confirmed";
    case "submitted":
      return "transaction_submitted";
    case "failed":
    case "rejected":
      return "payment_failed";
    case "expired":
      return "expired";
    default:
      break;
  }
  if (now > record.expiresAt) return "expired";
  return "awaiting_payment";
}

export type CreateCheckoutInput = {
  developerId: string;
  intentId: string;
  orderReference?: string | null;
  ttlMs?: number;
  idempotencyKey?: string | null;
  now?: number;
};

/**
 * Bind an intent to a checkout: freeze its parameters and advance it to
 * `awaiting_authorization`, so it is ready for a customer's wallet to pay and its
 * recipient/amount/asset can never change afterwards.
 *
 * Freezing the *parameters* is the merchant defining the order — it is not the
 * merchant authorizing a transaction on the customer's behalf. The customer's
 * wallet signature is the transaction authorization (see `recordCheckoutSubmission`).
 */
export async function bindIntentForCheckout(intent: ApiIntentRecord, now = Date.now()): Promise<IntentState> {
  const { transition, freezeParams } = await import("./intents");
  let state = await currentState(intent.id);
  if (state === "created") {
    await transition(intent, "validating", null, now, { silent: true });
    state = await currentState(intent.id);
  }
  if (state === "validating") {
    await transition(intent, "validated", null, now, { silent: true });
    state = await currentState(intent.id);
  }
  if (state === "validated") {
    await transition(intent, "prepared", null, now, { silent: true });
    state = await currentState(intent.id);
  }
  // Freeze first, then move the state machine, so a crash between the two leaves
  // the parameters frozen (the safe direction).
  await freezeParams(intent, now);
  if (state === "prepared") {
    await transition(intent, "awaiting_authorization", null, now, { silent: true });
    state = await currentState(intent.id);
  }
  return state;
}

export type CreateCheckoutResult =
  | { ok: true; checkout: ApiCheckoutRecord; token: string; created: boolean }
  | { ok: false; code: "conflict" | "not_found" };

/**
 * Create a checkout for an intent. The intent must already exist and be owned by
 * the developer (the caller passes the already-scoped record). Idempotent on the
 * idempotency key: a repeated create returns the original checkout and its link.
 */
export async function createCheckout(
  intent: ApiIntentRecord,
  input: CreateCheckoutInput,
): Promise<CreateCheckoutResult> {
  const now = input.now ?? Date.now();
  const store = getStore();
  const key = input.idempotencyKey?.trim() || null;

  if (key) {
    const existing = await store.findOne("apiCheckouts", { developerId: input.developerId, idempotencyKey: key });
    if (existing) {
      // A reused key must describe the same order; a different intent is a
      // conflict, not a silent overwrite.
      if (existing.intentId !== intent.id) return { ok: false, code: "conflict" };
      return { ok: true, checkout: existing, token: existing.token, created: false };
    }
  }

  // One intent backs at most one checkout — a payable order is created once.
  const byIntent = await store.findOne("apiCheckouts", { intentId: intent.id });
  if (byIntent) {
    if (key && byIntent.idempotencyKey === key) return { ok: true, checkout: byIntent, token: byIntent.token, created: false };
    return { ok: false, code: "conflict" };
  }

  const token = newCheckoutToken();
  const record: ApiCheckoutRecord = {
    id: newCheckoutId(),
    developerId: input.developerId,
    intentId: intent.id,
    orderReference: input.orderReference?.slice(0, 120) ?? null,
    token,
    tokenHint: hintOf(token),
    status: "open",
    expiresAt: now + (input.ttlMs ?? CHECKOUT_TTL_MS),
    completedAt: null,
    canceledAt: null,
    idempotencyKey: key,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await store.insert("apiCheckouts", record);
  } catch {
    // Lost a race — adopt the winner (by intent, then by idempotency key).
    const winner =
      (await store.findOne("apiCheckouts", { intentId: intent.id })) ??
      (key ? await store.findOne("apiCheckouts", { developerId: input.developerId, idempotencyKey: key }) : undefined);
    if (winner) return { ok: true, checkout: winner, token: winner.token, created: false };
    return { ok: false, code: "conflict" };
  }
  return { ok: true, checkout: record, token, created: true };
}

/** Fetch a checkout scoped to its owner. Returns null when not found/owned. */
export async function getCheckout(developerId: string, id: string): Promise<ApiCheckoutRecord | null> {
  const row = await getStore().findOne("apiCheckouts", { id });
  if (!row || row.developerId !== developerId) return null;
  return row;
}

/** Fetch a checkout by its public token. Returns null when not found. */
export async function getCheckoutByToken(token: string): Promise<ApiCheckoutRecord | null> {
  if (!isValidCheckoutToken(token)) return null;
  const row = await getStore().findOne("apiCheckouts", { token });
  return row ?? null;
}

/** Fetch the checkout bound to an intent, if any. */
export async function getCheckoutByIntent(intentId: string): Promise<ApiCheckoutRecord | null> {
  return (await getStore().findOne("apiCheckouts", { intentId })) ?? null;
}

/** A developer's checkouts, newest first. */
export async function listCheckouts(developerId: string, limit = 50): Promise<ApiCheckoutRecord[]> {
  return getStore().findMany("apiCheckouts", { developerId }, { orderBy: "createdAt", dir: "desc", limit });
}

/**
 * Cancel an open checkout. Only an open, unpaid checkout can be canceled — a
 * submitted or verified one cannot (that would discard a real payment). The
 * bound intent is moved to `expired` so the customer can no longer pay it.
 */
export async function cancelCheckout(
  record: ApiCheckoutRecord,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; code: "invalid_state"; message: string }> {
  const intent = await getStore().findOne("apiIntents", { id: record.intentId });
  if (!intent) return { ok: false, code: "invalid_state", message: "The bound intent no longer exists." };
  const state = await currentState(intent.id);
  if (state === "submitted" || state === "confirmed" || state === "verified") {
    return { ok: false, code: "invalid_state", message: "This checkout already has a submitted payment and cannot be canceled." };
  }
  if (record.status === "canceled") return { ok: true };

  await getStore().update("apiCheckouts", { id: record.id }, { status: "canceled", canceledAt: now, updatedAt: now });
  record.status = "canceled";
  record.canceledAt = now;
  // Cancel the underlying intent too (unless it is already terminal), so the
  // customer's payment page stops offering a payable order.
  if (state !== "expired" && state !== "failed" && state !== "rejected") {
    const { transition } = await import("./intents");
    await transition(intent, "expired", "Checkout canceled by the merchant.", now, { silent: true });
  }
  return { ok: true };
}

/**
 * Expire a checkout that has aged out. Idempotent; a no-op for an already-paid,
 * canceled or terminal one. Expires the bound intent too (unless it is already
 * past submission), so a stale link cannot be paid.
 *
 * The checkout's own `expiresAt` is authoritative for the order: when it passes,
 * the intent is expired as well, so the payment page stops offering a payable
 * order even if the intent's own TTL has not elapsed.
 */
export async function expireCheckoutIfStale(record: ApiCheckoutRecord, now = Date.now()): Promise<CheckoutStatus> {
  const { transition } = await import("./intents");
  const { enqueueEvent } = await import("./webhooks");
  const intent = await getStore().findOne("apiIntents", { id: record.intentId });
  if (!intent) return "failed";

  let state = await expireIfStale(intent, now);

  const preSubmission = state !== "submitted" && state !== "confirmed" && state !== "verified";
  const terminal = state === "expired" || state === "failed" || state === "rejected" || state === "verified";
  if (now > record.expiresAt && preSubmission && !terminal) {
    const result = await transition(intent, "expired", "Checkout expired before payment.", now, { silent: true });
    if (result.ok) state = result.state;
  }

  const status = checkoutStatus(record, state, now);
  if (status === "expired" && record.status !== "expired" && record.status !== "canceled" && record.status !== "completed") {
    await getStore().update("apiCheckouts", { id: record.id }, { status: "expired", updatedAt: now });
    record.status = "expired";
    await enqueueEvent({
      developerId: record.developerId,
      event: "checkout.expired",
      data: checkoutEventData(record, state),
      now,
    });
  }
  return status;
}

/** The public data payload for a checkout event. Never a secret. */
export function checkoutEventData(record: ApiCheckoutRecord, intentState: IntentState): Record<string, unknown> {
  return {
    checkoutId: record.id,
    intentId: record.intentId,
    orderReference: record.orderReference,
    status: checkoutStatus(record, intentState),
    intentState,
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

/** The public representation of a checkout, for a merchant (includes the link). */
export function publicCheckout(record: ApiCheckoutRecord, intentState: IntentState, now = Date.now()) {
  return {
    id: record.id,
    object: "checkout",
    status: checkoutStatus(record, intentState, now),
    phase: checkoutPhase(record, intentState, now),
    intentId: record.intentId,
    orderReference: record.orderReference,
    token: record.token,
    tokenHint: record.tokenHint,
    expiresAt: new Date(record.expiresAt).toISOString(),
    completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
    canceledAt: record.canceledAt ? new Date(record.canceledAt).toISOString() : null,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

/**
 * The public representation of a checkout for a customer reading it by token.
 *
 * Deliberately omits the merchant's tenant id, the internal idempotency key and
 * any other checkout the tenant owns. It carries only what a payer needs: what
 * they are paying, to whom, how long they have, and the current phase.
 */
export function publicCheckoutForCustomer(
  record: ApiCheckoutRecord,
  intent: ApiIntentRecord,
  intentState: IntentState,
  now = Date.now(),
) {
  return {
    id: record.id,
    object: "checkout",
    status: checkoutStatus(record, intentState, now),
    phase: checkoutPhase(record, intentState, now),
    orderReference: record.orderReference,
    chainId: intent.chainId,
    recipient: intent.recipient,
    receiveToken: intent.receiveToken,
    receiveTokenAddress: intent.receiveTokenAddress,
    amountMode: intent.amountMode,
    amount: intent.amount,
    payToken: intent.payToken,
    expiresAt: new Date(record.expiresAt).toISOString(),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

/** The recorded transaction hashes for a checkout's intent (oldest first). */
export async function checkoutTxHashes(intentId: string): Promise<string[]> {
  return submittedTxHashes(intentId);
}

/** The intent lifecycle for a checkout's bound intent. */
export async function checkoutLifecycle(intentId: string): Promise<Array<{ state: string; at: string; detail: string | null }>> {
  const events = await intentEvents(intentId);
  return events.map((e) => ({ state: e.state, at: new Date(e.at).toISOString(), detail: e.detail }));
}

/**
 * Record a customer's broadcast transaction hash(es) against the checkout.
 *
 * The intent-level transitions are `silent` (no `transaction.*` events); the
 * merchant instead receives the order-scoped `payment.submitted`, so exactly one
 * event describes the fact.
 */
export async function recordCheckoutSubmission(
  record: ApiCheckoutRecord,
  intent: ApiIntentRecord,
  hashes: string[],
  now = Date.now(),
): Promise<{ ok: true; state: IntentState } | { ok: false; code: "invalid_state"; message: string }> {
  const { transition } = await import("./intents");
  const { enqueueEvent } = await import("./webhooks");
  const state = await currentState(intent.id);
  if (state === "submitted" || state === "confirmed" || state === "verified") {
    return { ok: false, code: "invalid_state", message: "This checkout already has a submitted transaction." };
  }
  if (state === "expired" || state === "failed" || state === "rejected") {
    return { ok: false, code: "invalid_state", message: "This checkout can no longer be paid." };
  }
  if (!intent.authorizedParams) {
    return { ok: false, code: "invalid_state", message: "This checkout is not ready to be paid yet." };
  }
  const result = await transition(intent, "submitted", `tx:${hashes.join(",")}`.slice(0, 300), now, { silent: true });
  if (!result.ok) return { ok: false, code: "invalid_state", message: result.message };
  await enqueueEvent({
    developerId: record.developerId,
    event: "payment.submitted",
    data: { ...checkoutEventData(record, "submitted"), txHashes: hashes },
    now,
  });
  return { ok: true, state: "submitted" };
}

/**
 * Record a confirmed-then-verified settlement for the checkout. Emits
 * `payment.confirmed` (the receipt succeeded) and then `payment.verified` (the
 * recipient was proven paid) — never `payment.verified` alone, so a merchant can
 * tell "mined" from "delivered".
 */
export async function recordCheckoutVerified(
  record: ApiCheckoutRecord,
  intent: ApiIntentRecord,
  delivered: string,
  blockNumber: number | null,
  now = Date.now(),
): Promise<IntentState> {
  const { transition } = await import("./intents");
  const { enqueueEvent } = await import("./webhooks");
  let state = await currentState(intent.id);
  if (state === "submitted") {
    await transition(intent, "confirmed", blockNumber !== null ? `block:${blockNumber}` : null, now, { silent: true });
    state = await currentState(intent.id);
    await enqueueEvent({
      developerId: record.developerId,
      event: "payment.confirmed",
      data: { ...checkoutEventData(record, "confirmed"), blockNumber },
      now,
    });
  }
  if (state === "confirmed") {
    await transition(intent, "verified", `delivered:${delivered}`.slice(0, 300), now, { silent: true });
    state = await currentState(intent.id);
  }
  if (state === "verified") {
    await getStore().update("apiCheckouts", { id: record.id }, { status: "completed", completedAt: now, updatedAt: now });
    record.status = "completed";
    record.completedAt = now;
    await enqueueEvent({
      developerId: record.developerId,
      event: "payment.verified",
      data: { ...checkoutEventData(record, "verified"), delivered },
      now,
    });
  }
  return state;
}

/** Record a reverted / short settlement. Emits `payment.failed`. */
export async function recordCheckoutFailure(
  record: ApiCheckoutRecord,
  intent: ApiIntentRecord,
  detail: string,
  now = Date.now(),
): Promise<IntentState> {
  const { transition } = await import("./intents");
  const { enqueueEvent } = await import("./webhooks");
  let state = await currentState(intent.id);
  if (state === "submitted" || state === "confirmed") {
    await transition(intent, "failed", detail.slice(0, 300), now, { silent: true });
    state = await currentState(intent.id);
  }
  await getStore().update("apiCheckouts", { id: record.id }, { status: "failed", updatedAt: now });
  record.status = "failed";
  await enqueueEvent({
    developerId: record.developerId,
    event: "payment.failed",
    data: { ...checkoutEventData(record, "failed"), detail },
    now,
  });
  return state;
}
